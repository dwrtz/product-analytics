// Usage limits, sampling and the cost estimate (design.md "Usage limits", "Cost estimate").
import type { ProjectRow } from './env';
import { sampled } from '../shared/sample';

/** Per-project limits (projects.limits JSON). null caps mean "no cap". */
export type Limits = {
  events_monthly: number | null; replay_recordings_monthly: number | null; replay_bytes_monthly: number | null;
  /** What happens past a cap: drop everything, or keep a deterministic sample (by person for events, by session for replay). */
  over_cap: 'drop' | 'sample'; over_cap_sample_rate: number;
  /** Share of sessions whose $autocapture events are kept (sampled by $session_id, else distinct id); 1 keeps all. */
  autocapture_sample_rate: number;
  /** Alert recipients; empty sends to every user of the instance. */
  alert_emails: string[];
  /** Daily spike alert: yesterday over `spike_factor` times the 7-day average. */
  spike_alerts: boolean; spike_factor: number;
};
export const NO_LIMITS: Limits = { events_monthly: null, replay_recordings_monthly: null, replay_bytes_monthly: null, over_cap: 'drop', over_cap_sample_rate: 0.1, autocapture_sample_rate: 1, alert_emails: [], spike_alerts: true, spike_factor: 3 };
/** Defaults for projects created from 0.5 on (adjustable in settings). */
export const NEW_PROJECT_LIMITS: Limits = { ...NO_LIMITS, events_monthly: 1_000_000, replay_recordings_monthly: 5_000, replay_bytes_monthly: 5 * 1024 ** 3, autocapture_sample_rate: 0.5 };
export const NEW_PROJECT_REPLAY_SAMPLE_RATE = 0.25;
export const THRESHOLDS = [50, 80, 100];

export class LimitsError extends Error {}
const parseJson = (s: string | null | undefined): any => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
export function limitsOf(p: Pick<ProjectRow, 'limits'> | null | undefined): Limits { return { ...NO_LIMITS, ...(parseJson(p?.limits) ?? {}) }; }

/** Validates owner input merged over the current limits. */
export function cleanLimits(b: any, cur: Limits): Limits {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new LimitsError('limits must be an object');
  const out: Limits = { ...cur };
  const cap = (k: 'events_monthly' | 'replay_recordings_monthly' | 'replay_bytes_monthly') => {
    if (!(k in b)) return;
    const v = b[k]; if (v === null || v === '' || v === undefined) { out[k] = null; return; }
    const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 0 || n > 1e15) throw new LimitsError(`${k} must be a whole number >= 0 or null`); out[k] = n;
  };
  cap('events_monthly'); cap('replay_recordings_monthly'); cap('replay_bytes_monthly');
  const rate = (k: 'over_cap_sample_rate' | 'autocapture_sample_rate') => { if (!(k in b)) return; const n = Number(b[k]); if (!(n >= 0 && n <= 1)) throw new LimitsError(`${k} must be 0-1`); out[k] = n; };
  rate('over_cap_sample_rate'); rate('autocapture_sample_rate');
  if ('over_cap' in b) { if (b.over_cap !== 'drop' && b.over_cap !== 'sample') throw new LimitsError("over_cap must be 'drop' or 'sample'"); out.over_cap = b.over_cap; }
  if ('alert_emails' in b) {
    const list = Array.isArray(b.alert_emails) ? b.alert_emails : String(b.alert_emails ?? '').split(/[\s,;]+/);
    const emails = list.map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean);
    if (emails.length > 20) throw new LimitsError('at most 20 alert emails');
    for (const e of emails) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new LimitsError(`not an email address: ${e}`);
    out.alert_emails = [...new Set<string>(emails)];
  }
  if ('spike_alerts' in b) out.spike_alerts = !!b.spike_alerts;
  if ('spike_factor' in b) { const n = Number(b.spike_factor); if (!(n >= 1.5 && n <= 100)) throw new LimitsError('spike_factor must be 1.5-100'); out.spike_factor = n; }
  return out;
}

/** UTC calendar month of a timestamp, e.g. 2026-11. Caps are per UTC month. */
export const monthKey = (ts: number) => new Date(ts).toISOString().slice(0, 7);
export const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
export type CapState = { month: string; events: boolean; replay: boolean };
/** The project's cap state for the current month (a state from an earlier month means nothing is capped). */
export function capStateOf(p: Pick<ProjectRow, 'cap_state'> | null | undefined, now = Date.now()): CapState {
  const s = parseJson(p?.cap_state); const month = monthKey(now);
  return s && s.month === month ? { month, events: !!s.events, replay: !!s.replay } : { month, events: false, replay: false };
}

/** Edge gate for captured events: autocapture sampling, then the cap (protocol.md "Quota limiting"). */
export function gateEvents<E extends { event: string; distinct_id: string; properties: Record<string, unknown> }>(p: ProjectRow, events: E[], now = Date.now()): { keep: E[]; quotaLimited: string[] | null } {
  if (!p.limits) return { keep: events, quotaLimited: null };
  const L = limitsOf(p); const st = capStateOf(p, now);
  let keep = L.autocapture_sample_rate >= 1 ? events : events.filter(e => e.event !== '$autocapture' || sampled('ac:' + String(e.properties.$session_id ?? e.distinct_id), L.autocapture_sample_rate));
  if (st.events) {
    if (L.over_cap === 'drop') return { keep: [], quotaLimited: ['events', 'exceptionEvent'] };
    keep = keep.filter(e => sampled('cap:' + e.distinct_id, L.over_cap_sample_rate));
  }
  return { keep, quotaLimited: null };
}
/** Edge gate for replay: false drops the session's snapshots. */
export function replayAllowed(p: ProjectRow, sessionId: string, now = Date.now()): boolean {
  if (!p.limits) return true;
  const st = capStateOf(p, now); if (!st.replay) return true;
  const L = limitsOf(p); return L.over_cap === 'sample' && sampled('cap:' + sessionId, L.over_cap_sample_rate);
}
export const replayQuotaLimited = (p: ProjectRow, now = Date.now()) => !!p.limits && capStateOf(p, now).replay && limitsOf(p).over_cap === 'drop';
export const eventsQuotaLimited = (p: ProjectRow, now = Date.now()) => !!p.limits && capStateOf(p, now).events && limitsOf(p).over_cap === 'drop';

// ---------- cost estimate ----------
/**
 * Cloudflare list prices (USD) from the public pricing pages, read 2026-11-19:
 * developers.cloudflare.com/workers/platform/pricing, /durable-objects/platform/pricing, /queues/platform/pricing,
 * /r2/pricing, /pipelines/platform/pricing, /email-service/platform/pricing. `included` is the monthly allowance of the
 * Workers Paid plan (shared by the whole account).
 */
export const PRICES = {
  workers_requests: { per: 1e6, usd: 0.30, included: 10e6, unit: 'requests' },
  workers_cpu_ms: { per: 1e6, usd: 0.02, included: 30e6, unit: 'CPU ms' },
  queue_ops: { per: 1e6, usd: 0.40, included: 1e6, unit: 'operations' },
  do_requests: { per: 1e6, usd: 0.15, included: 1e6, unit: 'requests' },
  do_gb_s: { per: 1e6, usd: 12.50, included: 400_000, unit: 'GB-s' },
  do_rows_read: { per: 1e6, usd: 0.001, included: 25e9, unit: 'rows' },
  do_rows_written: { per: 1e6, usd: 1.00, included: 50e6, unit: 'rows' },
  do_storage_gb: { per: 1, usd: 0.20, included: 5, unit: 'GB-month' },
  r2_storage_gb: { per: 1, usd: 0.015, included: 10, unit: 'GB-month' },
  r2_class_a: { per: 1e6, usd: 4.50, included: 1e6, unit: 'operations' },
  r2_class_b: { per: 1e6, usd: 0.36, included: 10e6, unit: 'operations' },
  pipelines_sink_gb: { per: 1, usd: 0.06, included: 50, unit: 'GB' },
  email: { per: 1000, usd: 0.35, included: 3000, unit: 'emails' },
} as const;
/** Modelling assumptions, shown next to the estimate. */
export const ASSUMPTIONS = {
  cpu_ms_per_request: 3, do_requests_per_message: 2, do_seconds_per_request: 0.01, do_memory_gb: 0.128,
  rows_written_per_event: 8, rows_read_per_event: 5, queue_ops_per_message: 3, r2_reads_per_recording: 2,
};
export type UsageTotals = {
  events: number; event_bytes: number; requests: number; recordings: number; replay_bytes: number; replay_chunks: number;
  emails: number; stored_db_bytes: number; stored_r2_bytes: number; cold_tier: boolean;
};
export type CostLine = { key: keyof typeof PRICES; label: string; quantity: number; unit: string; list_usd: number; after_included_usd: number };

/** Month cost from usage totals (already projected to a full month by the caller). */
export function estimateCost(u: UsageTotals) {
  const A = ASSUMPTIONS; const GB = 1024 ** 3;
  const msgs = u.requests + u.replay_chunks;
  const q: [keyof typeof PRICES, string, number][] = [
    ['workers_requests', 'Workers requests (capture + replay uploads)', msgs],
    ['workers_cpu_ms', 'Workers CPU time', msgs * A.cpu_ms_per_request * 2],
    ['queue_ops', 'Queues (write, read, delete per message)', msgs * A.queue_ops_per_message],
    ['do_requests', 'Durable Object requests (project store + event shard)', msgs * A.do_requests_per_message],
    ['do_gb_s', 'Durable Object duration', msgs * A.do_requests_per_message * A.do_seconds_per_request * A.do_memory_gb],
    ['do_rows_written', 'SQLite rows written (events, indexes, persons)', u.events * A.rows_written_per_event],
    ['do_rows_read', 'SQLite rows read at ingest', u.events * A.rows_read_per_event],
    ['do_storage_gb', 'SQLite storage (events, persons)', u.stored_db_bytes / GB],
    ['r2_storage_gb', 'R2 storage (replay, source maps)', u.stored_r2_bytes / GB],
    ['r2_class_a', 'R2 writes (replay chunks)', u.replay_chunks],
    ['r2_class_b', 'R2 reads (replay playback)', u.recordings * A.r2_reads_per_recording],
    ['email', 'Alert emails', u.emails],
  ];
  if (u.cold_tier) q.push(['pipelines_sink_gb', 'Pipelines Iceberg sink (cold tier)', u.event_bytes / GB]);
  const lines: CostLine[] = q.map(([key, label, quantity]) => {
    const p = PRICES[key];
    return { key, label, quantity, unit: p.unit, list_usd: quantity / p.per * p.usd, after_included_usd: Math.max(0, quantity - p.included) / p.per * p.usd };
  });
  return { lines, list_usd: lines.reduce((a, l) => a + l.list_usd, 0), after_included_usd: lines.reduce((a, l) => a + l.after_included_usd, 0), assumptions: A,
    notes: ['Estimate at Cloudflare list prices, not a bill. "After included" assumes this project is the only usage on the account; the Workers Paid plan itself is $5/month.',
      'Requests are counted at ingest (one per capture request); SDK config and flag requests, dashboard use and events dropped at the edge are not counted.',
      ...(u.cold_tier ? ['Pipelines billing is not yet switched on by Cloudflare; the line shows the published price.'] : [])] };
}
