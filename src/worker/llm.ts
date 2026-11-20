// LLM analytics (design.md "LLM analytics", protocol.md "LLM analytics"): `$ai_generation`, `$ai_embedding`, `$ai_span`
// and `$ai_trace` events from PostHog's LLM SDK wrappers are ordinary events; this module turns the compact rows read
// from the event shards (eventsql.llmRows) into the overview, the trace list and one trace's span tree.
import { LLM_PROPS } from './eventsql';
import { costOf } from '../shared/llm-pricing';
import { percentile } from './query';
import { buckets, resolveRange, label as bucketLabel, type Interval } from '../shared/dates';

export type LlmRow = {
  uuid: string; event: string; distinct_id: string; ts: number; trace_id: string; span_id: string | null; parent_id: string | null; name: string | null;
  model: string | null; provider: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number | null; cost_source: 'sdk' | 'pricing' | null;
  latency_ms: number | null; is_error: boolean; error: string | null; http_status: number | null; session_id: string | null; properties?: Record<string, unknown>;
};
const n = (v: unknown) => { const x = typeof v === 'string' ? Number(v) : v; return typeof x === 'number' && Number.isFinite(x) ? x : null; };
const str = (v: unknown) => v === null || v === undefined || v === '' ? null : typeof v === 'string' ? v : JSON.stringify(v);
/** A raw shard row (uuid, event, distinct_id, timestamp, LLM_PROPS..., [properties]) as an LlmRow. */
export function toLlmRow(r: unknown[]): LlmRow {
  const p: Record<string, unknown> = {}; LLM_PROPS.forEach((k, i) => { p[k] = r[4 + i]; });
  let props: Record<string, unknown> | undefined;
  if (r.length > 4 + LLM_PROPS.length && typeof r[4 + LLM_PROPS.length] === 'string') { try { props = JSON.parse(r[4 + LLM_PROPS.length] as string); } catch { /* keep compact */ } }
  const event = String(r[1]); const uuid = String(r[0]);
  const c = event === '$ai_generation' || event === '$ai_embedding' ? costOf(props ?? p) : { usd: null, source: null };
  const isErr = p.$ai_is_error === true || p.$ai_is_error === 1 || p.$ai_is_error === 'true' || (n(p.$ai_http_status) ?? 0) >= 400 || (p.$ai_error !== null && p.$ai_error !== undefined && p.$ai_error !== false);
  const lat = n(p.$ai_latency);
  return {
    uuid, event, distinct_id: String(r[2]), ts: Number(r[3]), trace_id: str(p.$ai_trace_id) ?? uuid, span_id: str(p.$ai_span_id) ?? (event === '$ai_trace' ? null : uuid), parent_id: str(p.$ai_parent_id),
    name: str(p.$ai_span_name) ?? str(p.$ai_trace_name), model: str(p.$ai_model), provider: str(p.$ai_provider), input_tokens: n(p.$ai_input_tokens) ?? 0, output_tokens: n(p.$ai_output_tokens) ?? 0,
    cache_read_tokens: n(p.$ai_cache_read_input_tokens) ?? 0, cost_usd: c.usd, cost_source: c.source, latency_ms: lat === null ? null : Math.round(lat * 1000), is_error: !!isErr,
    error: isErr ? (str(p.$ai_error)?.slice(0, 2000) ?? (n(p.$ai_http_status) ? `HTTP ${n(p.$ai_http_status)}` : 'error')) : null, http_status: n(p.$ai_http_status), session_id: str(p.$session_id), ...(props ? { properties: props } : {}),
  };
}
const isCall = (r: LlmRow) => r.event === '$ai_generation' || r.event === '$ai_embedding';
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

export type LlmFilters = { model?: string | null; provider?: string | null; status?: 'ok' | 'error' | null; search?: string | null };
/** Overview over a date range: totals, latency percentiles, error rate, a series per interval and a model breakdown. */
export function llmOverview(rows: LlmRow[], o: { from: number; to: number; interval: Interval; tz: string; filters?: LlmFilters }) {
  const calls = rows.filter(isCall).filter(r => match(r, o.filters));
  const bks = buckets({ from: o.from, to: o.to }, o.interval, o.tz);
  const starts = bks.map(b => b.start);
  const idx = (ts: number) => { let lo = 0, hi = starts.length - 1, best = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= ts) { best = m; lo = m + 1; } else hi = m - 1; } return best; };
  const series = { generations: bks.map(() => 0), cost_usd: bks.map(() => 0), input_tokens: bks.map(() => 0), output_tokens: bks.map(() => 0), errors: bks.map(() => 0) };
  const lat: number[] = []; const models = new Map<string, any>(); const traces = new Set<string>(); const users = new Set<string>();
  let cost = 0, inTok = 0, outTok = 0, errors = 0, priced = 0, unpriced = 0;
  for (const r of calls) {
    const i = idx(r.ts); if (i >= 0) { if (r.event === '$ai_generation') series.generations[i]++; series.cost_usd[i] += r.cost_usd ?? 0; series.input_tokens[i] += r.input_tokens; series.output_tokens[i] += r.output_tokens; if (r.is_error) series.errors[i]++; }
    cost += r.cost_usd ?? 0; inTok += r.input_tokens; outTok += r.output_tokens; if (r.is_error) errors++; if (r.latency_ms !== null) lat.push(r.latency_ms);
    if (r.cost_usd === null) unpriced++; else priced++;
    traces.add(r.trace_id); users.add(r.distinct_id);
    const k = `${r.provider ?? '?'}\u0000${r.model ?? '?'}`; const m = models.get(k) ?? { provider: r.provider, model: r.model, generations: 0, embeddings: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, errors: 0, lat: [] as number[] };
    if (r.event === '$ai_embedding') m.embeddings++; else m.generations++;
    m.input_tokens += r.input_tokens; m.output_tokens += r.output_tokens; m.cost_usd += r.cost_usd ?? 0; if (r.is_error) m.errors++; if (r.latency_ms !== null) m.lat.push(r.latency_ms);
    models.set(k, m);
  }
  lat.sort((a, b) => a - b);
  return {
    totals: { generations: calls.filter(r => r.event === '$ai_generation').length, embeddings: calls.filter(r => r.event === '$ai_embedding').length, traces: traces.size, users: users.size,
      input_tokens: inTok, output_tokens: outTok, cost_usd: round(cost), priced_calls: priced, unpriced_calls: unpriced,
      latency_p50_ms: lat.length ? percentile(lat, 0.5) : null, latency_p95_ms: lat.length ? percentile(lat, 0.95) : null, errors, error_rate: calls.length ? errors / calls.length : 0 },
    labels: bks.map(b => b.label), days: bks.map(b => new Date(b.start).toISOString()), series: { ...series, cost_usd: series.cost_usd.map(x => round(x)) },
    models: [...models.values()].map(m => { m.lat.sort((a: number, b: number) => a - b); const { lat: l, ...rest } = m; return { ...rest, cost_usd: round(m.cost_usd), latency_p50_ms: l.length ? percentile(l, 0.5) : null, error_rate: (m.generations + m.embeddings) ? m.errors / (m.generations + m.embeddings) : 0 }; })
      .sort((a, b) => b.cost_usd - a.cost_usd || b.generations - a.generations),
  };
}
function match(r: LlmRow, f?: LlmFilters) {
  if (!f) return true;
  if (f.model && r.model !== f.model) return false;
  if (f.provider && r.provider !== f.provider) return false;
  return true;
}
/** Traces grouped by `$ai_trace_id` (a generation without one is its own trace), newest first. */
export function llmTraces(rows: LlmRow[], f: LlmFilters = {}, limit = 100) {
  const by = new Map<string, LlmRow[]>(); for (const r of rows) { const a = by.get(r.trace_id); if (a) a.push(r); else by.set(r.trace_id, [r]); }
  const out = [...by].map(([id, rs]) => {
    const root = rs.find(r => r.event === '$ai_trace') ?? rs.find(r => !r.parent_id || r.parent_id === id) ?? rs[rs.length - 1];
    const calls = rs.filter(isCall);
    const start = Math.min(...rs.map(r => r.ts)); const end = Math.max(...rs.map(r => r.ts + (r.latency_ms ?? 0)));
    const errs = rs.filter(r => r.is_error);
    return { id, name: root.name ?? (root.event === '$ai_generation' ? root.model : null) ?? root.event.replace('$ai_', ''), timestamp: start, distinct_id: root.distinct_id, session_id: root.session_id,
      models: [...new Set(calls.map(r => r.model).filter(Boolean))] as string[], providers: [...new Set(calls.map(r => r.provider).filter(Boolean))] as string[],
      spans: rs.length, generations: calls.length, input_tokens: calls.reduce((a, r) => a + r.input_tokens, 0), output_tokens: calls.reduce((a, r) => a + r.output_tokens, 0),
      cost_usd: round(calls.reduce((a, r) => a + (r.cost_usd ?? 0), 0)), latency_ms: root.event === '$ai_trace' && root.latency_ms !== null ? root.latency_ms : Math.max(0, end - start),
      status: errs.length ? 'error' : 'ok', error: errs[0]?.error ?? null };
  }).filter(t => {
    if (f.model && !t.models.includes(f.model)) return false;
    if (f.provider && !t.providers.includes(f.provider)) return false;
    if (f.status && t.status !== f.status) return false;
    if (f.search) { const q = f.search.toLowerCase(); if (![t.id, t.name ?? '', t.distinct_id, ...t.models].some(x => String(x).toLowerCase().includes(q))) return false; }
    return true;
  }).sort((a, b) => b.timestamp - a.timestamp);
  return { results: out.slice(0, limit), total: out.length,
    facets: { models: [...new Set(rows.map(r => r.model).filter(Boolean))].sort() as string[], providers: [...new Set(rows.map(r => r.provider).filter(Boolean))].sort() as string[] } };
}
const clip = (v: unknown, max = 100_000) => { if (v === undefined) return null; const s = typeof v === 'string' ? v : JSON.stringify(v); if (s === undefined) return null; return s.length > max ? (typeof v === 'string' ? v.slice(0, max) + '…' : s.slice(0, max) + '…') : v; };
/** One trace: its events as a tree (by `$ai_parent_id`) with offsets for a latency waterfall, inputs and outputs. */
export function llmTrace(rows: LlmRow[], id: string) {
  if (!rows.length) return null;
  const rs = rows.slice().sort((a, b) => a.ts - b.ts);
  const root = rs.find(r => r.event === '$ai_trace');
  const start = Math.min(...rs.map(r => r.ts - (r.event === '$ai_trace' ? 0 : 0)));
  const nodes = rs.filter(r => r !== root).map(r => {
    const p = r.properties ?? {}; const lat = r.latency_ms ?? 0;
    // Events are captured when a call ends: start = timestamp - latency.
    const s0 = r.ts - lat;
    return { uuid: r.uuid, event: r.event, span_id: r.span_id, parent_id: r.parent_id && r.parent_id !== id ? r.parent_id : null, name: r.name ?? (r.event === '$ai_generation' ? r.model : r.event === '$ai_embedding' ? 'embedding' : 'span'),
      model: r.model, provider: r.provider, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, cost_usd: r.cost_usd, cost_source: r.cost_source,
      latency_ms: r.latency_ms, start_ms: s0, timestamp: r.ts, is_error: r.is_error, error: r.error, http_status: r.http_status,
      input: clip(p.$ai_input ?? p.$ai_input_state), output: clip(p.$ai_output_choices ?? p.$ai_output ?? p.$ai_output_state), tools: clip(p.$ai_tools, 20_000), base_url: str(p.$ai_base_url), temperature: n(p.$ai_temperature), stream: p.$ai_stream ?? null, children: [] as any[] };
  });
  const t0 = Math.min(start, ...nodes.map(x => x.start_ms)); const byId = new Map(nodes.filter(x => x.span_id).map(x => [x.span_id!, x]));
  const top: any[] = [];
  for (const x of nodes) { (x as any).offset_ms = x.start_ms - t0; const par = x.parent_id ? byId.get(x.parent_id) : null; if (par && par !== x) par.children.push(x); else top.push(x); }
  const calls = rs.filter(isCall);
  const end = Math.max(...nodes.map(x => x.start_ms + (x.latency_ms ?? 0)), ...(root ? [root.ts] : []));
  const rp = root?.properties ?? {};
  return { id, name: root?.name ?? top[0]?.name ?? id, timestamp: t0, distinct_id: (root ?? rs[0]).distinct_id, session_id: (root ?? rs[0]).session_id,
    latency_ms: root?.latency_ms ?? Math.max(0, end - t0), input_tokens: calls.reduce((a, r) => a + r.input_tokens, 0), output_tokens: calls.reduce((a, r) => a + r.output_tokens, 0),
    cost_usd: round(calls.reduce((a, r) => a + (r.cost_usd ?? 0), 0)), status: rs.some(r => r.is_error) ? 'error' : 'ok',
    input: clip(rp.$ai_input_state ?? rp.$ai_input), output: clip(rp.$ai_output_state ?? rp.$ai_output), tree: top };
}
export function llmRange(q: { date_from?: string | null; date_to?: string | null }, tz: string, now = Date.now()) { return resolveRange(q.date_from || '-7d', q.date_to || null, tz, now); }
export { bucketLabel };
