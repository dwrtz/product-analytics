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

/** All rrweb events of a session in time order, ready for rrweb-player. */
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
export function recordingConfig(p: ProjectRow) {
  if (!p.session_recording) return false;
  return { endpoint: '/s/', consoleLogRecordingEnabled: true, recorderVersion: 'v2', sampleRate: null, minimumDurationMilliseconds: null, linkedFlag: null,
    networkPayloadCapture: null, masking: null, urlTriggers: [], urlBlocklist: [], eventTriggers: [], triggerMatchType: null, scriptConfig: null };
}
