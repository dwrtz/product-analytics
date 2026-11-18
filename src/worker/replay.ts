// Session replay (design.md "Session replay", protocol.md "Snapshots"): posthog-js's recorder POSTs `$snapshot` events to
// /s/. Each request's rrweb events are stored per session as a gzip JSON chunk in R2; per-session metadata travels through
// the ingest queue to the head ProjectStore. Reads decompress posthog-js's `cv: '2024-10'` field compression.
import { Env, IngestMsg, json, ProjectRow } from './env';
import { cors } from './capture';
import { decodeBody, DecodeError } from '../shared/decode';
import { projectByToken, validToken } from './projects';

export type ReplayMeta = {
  session_id: string; distinct_id: string; start_ts: number; end_ts: number; clicks: number; keypresses: number;
  console_errors: number; first_url: string | null; size: number; chunks: number;
};
const obj = (v: unknown): Record<string, any> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined;
const SAFE = /^[A-Za-z0-9._:-]{1,200}$/;
export const chunkPrefix = (pid: number, session?: string) => `replay/${pid}/` + (session ? `${session}/` : '');

async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}
async function gunzipBytes(b: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/** Facts about one batch of rrweb events (rrweb event types: 2 full snapshot, 3 incremental, 4 meta, 5 custom, 6 plugin). */
export function summarize(items: any[]) {
  let start = Infinity, end = -Infinity, clicks = 0, keypresses = 0, errors = 0; let url: string | null = null;
  for (const it of items) {
    const t = Number(it?.timestamp); if (Number.isFinite(t)) { start = Math.min(start, t); end = Math.max(end, t); }
    const d = obj(it?.data);
    if (it?.type === 3 && d) { if (d.source === 2 && d.type === 2) clicks++; if (d.source === 5) keypresses++; }
    if (it?.type === 4 && d && !url && typeof d.href === 'string') url = d.href;
    if (it?.type === 6 && d?.plugin === 'rrweb/console@1' && d.payload?.level === 'error') errors++;
  }
  return { start, end, clicks, keypresses, errors, url };
}

export async function handleSnapshots(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== 'POST') return json({ status: 1 }, 200, cors(req));
  let body: any;
  try {
    const text = await decodeBody(new Uint8Array(await req.arrayBuffer()), { compression: url.searchParams.get('compression'), contentType: req.headers.get('content-type'), contentEncoding: req.headers.get('content-encoding') });
    body = JSON.parse(text);
  } catch (e) { return json({ type: 'validation_error', code: e instanceof DecodeError && e.code === 'payload_too_large' ? 'payload_too_large' : 'invalid_payload', detail: 'Malformed request data.' }, e instanceof DecodeError && e.code === 'payload_too_large' ? 413 : 400, cors(req)); }
  const events: any[] = Array.isArray(body) ? body : Array.isArray(body?.batch) ? body.batch : [body];
  const fallbackToken = body?.api_key ?? body?.token ?? url.searchParams.get('token') ?? url.searchParams.get('api_key');
  // project -> session -> { did, items, window }
  const groups = new Map<number, { project: ProjectRow; sessions: Map<string, { did: string; items: any[] }> }>();
  for (const ev of events) {
    const e = obj(ev); if (!e || (e.event !== '$snapshot' && e.event !== '$snapshot_items')) continue;
    const p = obj(e.properties) ?? {};
    const token = p.token ?? e.api_key ?? e.token ?? fallbackToken;
    if (!validToken(token)) continue;
    const project = await projectByToken(env, token);
    if (!project || !project.session_recording) continue;
    const sid = String(p.$session_id ?? ''); if (!SAFE.test(sid)) continue;
    const items = Array.isArray(p.$snapshot_data) ? p.$snapshot_data : Array.isArray(p.$snapshot_items) ? p.$snapshot_items : obj(p.$snapshot_data) ? [p.$snapshot_data] : [];
    if (!items.length) continue;
    const did = String(e.distinct_id ?? p.distinct_id ?? '');
    let g = groups.get(project.id); if (!g) groups.set(project.id, g = { project, sessions: new Map() });
    let s = g.sessions.get(sid); if (!s) g.sessions.set(sid, s = { did, items: [] });
    for (const it of items) s.items.push(p.$window_id && obj(it) ? { ...it, windowId: it.windowId ?? p.$window_id } : it);
  }
  for (const [pid, g] of groups) {
    const metas: ReplayMeta[] = [];
    for (const [sid, s] of g.sessions) {
      const text = JSON.stringify(s.items); const f = summarize(s.items);
      if (!Number.isFinite(f.start)) continue;
      const key = `${chunkPrefix(pid, sid)}${String(f.start).padStart(15, '0')}-${crypto.randomUUID().slice(0, 8)}`;
      await env.REPLAY.put(key, await gzip(text), { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' } });
      metas.push({ session_id: sid, distinct_id: s.did, start_ts: f.start, end_ts: f.end, clicks: f.clicks, keypresses: f.keypresses, console_errors: f.errors, first_url: f.url, size: text.length, chunks: 1 });
    }
    if (metas.length) await env.INGEST.send({ pid, replay: metas } satisfies IngestMsg, { contentType: 'json' });
  }
  return json({ status: 1 }, 200, cors(req));
}

/** posthog-js field compression (`cv: '2024-10'`): gzip bytes carried as a latin1 string, JSON inside. */
async function unpack(v: unknown): Promise<unknown> {
  if (typeof v !== 'string') return v;
  const bytes = new Uint8Array(v.length); for (let i = 0; i < v.length; i++) bytes[i] = v.charCodeAt(i) & 0xff;
  return JSON.parse(new TextDecoder().decode(await gunzipBytes(bytes)));
}
export async function decompressEvent(it: any): Promise<any> {
  if (!it || it.cv !== '2024-10') return it;
  const out = { ...it }; delete out.cv;
  if (it.type === 2) out.data = await unpack(it.data);
  else if (it.type === 3 && obj(it.data)) {
    const d = { ...it.data };
    const fields = d.source === 0 ? ['texts', 'attributes', 'removes', 'adds'] : d.source === 8 ? ['adds', 'removes'] : [];
    for (const f of fields) if (typeof d[f] === 'string') d[f] = await unpack(d[f]);
    out.data = d;
  }
  return out;
}

/**
 * One page of a session's rrweb events: chunks in key (start time) order after `cursor` (a chunk key) until about
 * `pageBytes` of JSON; `next` is the cursor for the following page. The player appends pages as they arrive, so a
 * recording of any size streams (design.md "Session replay").
 */
export async function readSnapshotsPage(env: Env, pid: number, sid: string, cursor: string | null, pageBytes = 16 * 1024 * 1024): Promise<{ snapshots: any[]; next: string | null }> {
  if (!SAFE.test(sid)) return { snapshots: [], next: null };
  const prefix = chunkPrefix(pid, sid);
  if (cursor && (!cursor.startsWith(prefix) || cursor.length > 400)) return { snapshots: [], next: null };
  const keys: string[] = []; let lc: string | undefined;
  do { const l = await env.REPLAY.list({ prefix, cursor: lc, startAfter: cursor ?? undefined }); keys.push(...l.objects.map(o => o.key)); lc = l.truncated ? l.cursor : undefined; } while (lc);
  keys.sort();
  const out: any[] = []; let total = 0; let last: string | null = null;
  for (const k of keys) {
    if (cursor && k <= cursor) continue;
    if (total > 0 && total >= pageBytes) break;
    const o = await env.REPLAY.get(k); last = k; if (!o) continue;
    const text = new TextDecoder().decode(await gunzipBytes(await o.arrayBuffer()));
    total += text.length;
    for (const it of JSON.parse(text)) out.push(await decompressEvent(it));
  }
  out.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const more = last !== null && keys.some(k => k > last!);
  return { snapshots: out, next: more ? last : null };
}
/** All rrweb events of a session in time order (tests and small sessions; the UI pages with readSnapshotsPage). */
export async function readSnapshots(env: Env, pid: number, sid: string, maxBytes = 64 * 1024 * 1024): Promise<any[]> {
  if (!SAFE.test(sid)) return [];
  const keys: string[] = []; let cursor: string | undefined;
  do { const l = await env.REPLAY.list({ prefix: chunkPrefix(pid, sid), cursor }); keys.push(...l.objects.map(o => o.key)); cursor = l.truncated ? l.cursor : undefined; } while (cursor);
  keys.sort();
  const out: any[] = []; let total = 0;
  for (const k of keys) {
    const o = await env.REPLAY.get(k); if (!o) continue;
    const text = new TextDecoder().decode(await gunzipBytes(await o.arrayBuffer()));
    total += text.length; if (total > maxBytes) break;
    for (const it of JSON.parse(text)) out.push(await decompressEvent(it));
  }
  out.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return out;
}
export async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let n = 0; let cursor: string | undefined;
  do {
    const l = await env.REPLAY.list({ prefix, cursor });
    if (l.objects.length) { await env.REPLAY.delete(l.objects.map(o => o.key)); n += l.objects.length; }
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return n;
}
/** Per-project replay settings (projects.replay_config), all optional. */
export type ReplayConfig = {
  sample_rate?: number | null; minimum_duration_ms?: number | null; linked_flag?: { key: string; variant?: string | null } | null;
  console?: boolean; network?: { timing?: boolean; headers?: boolean; body?: boolean } | null;
  canvas?: { enabled?: boolean; fps?: number; quality?: number } | null;
  url_triggers?: string[]; url_blocklist?: string[]; event_triggers?: string[]; trigger_match?: 'any' | 'all';
  masking?: { mask_all_inputs?: boolean; mask_text_selector?: string | null; block_selector?: string | null } | null;
};
export class ReplayConfigError extends Error {}
/** Validates owner input into a stored ReplayConfig. */
export function cleanReplayConfig(c: any): ReplayConfig {
  if (!c || typeof c !== 'object') throw new ReplayConfigError('replay_config must be an object');
  const out: ReplayConfig = {};
  const re = (list: unknown, name: string) => { if (list === undefined || list === null) return []; if (!Array.isArray(list) || list.length > 50) throw new ReplayConfigError(`${name} must be a list of at most 50 regexes`); return list.map(x => { const s = String(x).slice(0, 1000); try { new RegExp(s); } catch { throw new ReplayConfigError(`${name}: invalid regex ${s}`); } return s; }); };
  if (c.sample_rate !== undefined && c.sample_rate !== null && c.sample_rate !== '') { const n = Number(c.sample_rate); if (!(n >= 0 && n <= 1)) throw new ReplayConfigError('sample_rate must be 0-1'); out.sample_rate = n; }
  if (c.minimum_duration_ms !== undefined && c.minimum_duration_ms !== null && c.minimum_duration_ms !== '') { const n = Math.floor(Number(c.minimum_duration_ms)); if (!(n >= 0 && n <= 3_600_000)) throw new ReplayConfigError('minimum_duration_ms must be 0-3600000'); out.minimum_duration_ms = n; }
  if (c.linked_flag && c.linked_flag.key) out.linked_flag = { key: String(c.linked_flag.key).slice(0, 200), variant: c.linked_flag.variant ? String(c.linked_flag.variant).slice(0, 200) : null };
  out.console = c.console !== false;
  if (c.network) out.network = { timing: !!c.network.timing, headers: !!c.network.headers, body: !!c.network.body };
  if (c.canvas) { const fps = Math.max(0, Math.min(12, Math.floor(Number(c.canvas.fps ?? 4)))); const q = Math.max(0, Math.min(1, Number(c.canvas.quality ?? 0.4))); out.canvas = { enabled: !!c.canvas.enabled, fps, quality: q }; }
  out.url_triggers = re(c.url_triggers, 'url_triggers'); out.url_blocklist = re(c.url_blocklist, 'url_blocklist');
  out.event_triggers = Array.isArray(c.event_triggers) ? c.event_triggers.slice(0, 50).map((x: unknown) => String(x).slice(0, 400)) : [];
  out.trigger_match = c.trigger_match === 'all' ? 'all' : 'any';
  if (c.masking) out.masking = { mask_all_inputs: c.masking.mask_all_inputs !== false, mask_text_selector: c.masking.mask_text_selector ? String(c.masking.mask_text_selector).slice(0, 1000) : null, block_selector: c.masking.block_selector ? String(c.masking.block_selector).slice(0, 1000) : null };
  return out;
}
export const replayConfigOf = (p: ProjectRow): ReplayConfig => { try { return p.replay_config ? JSON.parse(p.replay_config) : {}; } catch { return {}; } };
/** posthog-js remote config `sessionRecording` (protocol.md "Replay settings"). */
export function recordingConfig(p: ProjectRow) {
  if (!p.session_recording) return false;
  const c = replayConfigOf(p);
  const out: Record<string, unknown> = { endpoint: '/s/', consoleLogRecordingEnabled: c.console !== false, recorderVersion: 'v2',
    sampleRate: c.sample_rate === undefined || c.sample_rate === null ? null : c.sample_rate.toFixed(2),
    minimumDurationMilliseconds: c.minimum_duration_ms ?? null,
    linkedFlag: c.linked_flag ? (c.linked_flag.variant ? { flag: c.linked_flag.key, variant: c.linked_flag.variant } : c.linked_flag.key) : null,
    networkPayloadCapture: c.network && (c.network.headers || c.network.body) ? { recordHeaders: !!c.network.headers, recordBody: !!c.network.body } : null,
    masking: c.masking ? { maskAllInputs: c.masking.mask_all_inputs !== false, maskTextSelector: c.masking.mask_text_selector ?? undefined, blockSelector: c.masking.block_selector ?? undefined } : null,
    urlTriggers: (c.url_triggers ?? []).map(url => ({ url, matching: 'regex' })), urlBlocklist: (c.url_blocklist ?? []).map(url => ({ url, matching: 'regex' })),
    eventTriggers: c.event_triggers ?? [], triggerMatchType: (c.url_triggers?.length || c.event_triggers?.length) ? (c.trigger_match ?? 'any') : null, scriptConfig: null };
  if (c.canvas?.enabled) Object.assign(out, { recordCanvas: true, canvasFps: c.canvas.fps ?? 4, canvasQuality: String(c.canvas.quality ?? 0.4) });
  return out;
}
/** Top-level `capturePerformance`: network timing for replay's network panel. */
export function performanceConfig(p: ProjectRow) {
  const c = replayConfigOf(p);
  return p.session_recording && (c.network?.timing || c.network?.headers || c.network?.body) ? { network_timing: true, web_vitals: false } : false;
}
