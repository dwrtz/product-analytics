// Capture endpoints (spec R3, protocol.md): legacy /e /batch /capture /i/v0/e /engage /track, and /i/v1/analytics/events.
import { Env, NormEvent, ProjectRow, IngestMsg, json, storeFor } from './env';
import { decodeBody, DecodeError } from '../shared/decode';
import { parseDate, parseEventTimestamp } from '../shared/timestamp';
import { isUuid, uuidv7 } from '../shared/ids';
import { projectByToken, validToken } from './projects';
import { gateEvents } from './usage';
import { meter } from './meter';

export const LEGACY_PATHS = new Set(['/e', '/batch', '/capture', '/track', '/engage', '/i/v0/e', '/i/v0/ai/batch']);
export const V1_PATH = '/i/v1/analytics/events';
/** LLM analytics endpoints (protocol.md "LLM analytics"): JSON batch like legacy capture, one multipart event, or a v1 batch.
 * They only take `$ai_*` events; anything else is dropped as misrouted. */
export const AI_BATCH_PATH = '/i/v0/ai/batch';
export const AI_MULTIPART_PATH = '/i/v0/ai';
export const AI_V1_PATH = '/i/v1/ai/events';
export const isAiEvent = (name: unknown) => typeof name === 'string' && name.startsWith('$ai_');
const DROPPED_EVENTS = new Set(['$performance_event', '$snapshot', '$snapshot_items']);
const MSG_BUDGET = 100_000; // bytes of JSON per queue message (queue limit is 128 KB)

export function cors(req: Request): Record<string, string> {
  const o = req.headers.get('origin');
  return {
    'access-control-allow-origin': o ?? '*',
    ...(o ? { 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': req.headers.get('access-control-request-headers') ?? 'content-type',
    'access-control-max-age': '86400',
  };
}
const err = (req: Request, status: number, code: string, detail: string, type = 'validation_error') =>
  json({ type, code, detail, attr: null }, status, cors(req));

const obj = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const bool = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') { const s = v.toLowerCase(); if (['true', '1', 'on', 'yes'].includes(s)) return true; if (['false', '0', 'off', 'no'].includes(s)) return false; }
  return undefined;
};

/** Request-level facts shared by every event in it. */
type Ctx = { now: number; sentAt: number | null; ip: string | null; geo: Record<string, unknown>; libHeader?: [string, string] };

function geoProps(req: Request): Record<string, unknown> {
  const cf = (req as any).cf as Record<string, any> | undefined;
  if (!cf?.country) return {};
  let countryName: string | undefined;
  try { countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of(cf.country); } catch { /* optional */ }
  const g: Record<string, unknown> = {
    $geoip_country_code: cf.country, $geoip_country_name: countryName, $geoip_city_name: cf.city,
    $geoip_subdivision_1_name: cf.region, $geoip_subdivision_1_code: cf.regionCode, $geoip_postal_code: cf.postalCode,
    $geoip_continent_code: cf.continent, $geoip_time_zone: cf.timezone,
    $geoip_latitude: cf.latitude !== undefined ? Number(cf.latitude) : undefined, $geoip_longitude: cf.longitude !== undefined ? Number(cf.longitude) : undefined,
  };
  for (const k of Object.keys(g)) if (g[k] === undefined || g[k] === '') delete g[k];
  return g;
}

/** Normalizes one raw event; returns null to drop it (with a reason). */
export function normalize(raw: unknown, ctx: Ctx, opts: { v1: boolean; anonymizeIps: boolean; ignoreSentAt?: boolean }): NormEvent | { drop: string } {
  const e = obj(raw); if (!e) return { drop: 'invalid_event' };
  const event = e.event;
  if (typeof event !== 'string' || !event || event.length > 200) return { drop: 'invalid_event_name' };
  if (DROPPED_EVENTS.has(event)) return { drop: 'filtered' };
  const properties: Record<string, unknown> = { ...(obj(e.properties) ?? {}) };
  let did = e.distinct_id ?? properties.distinct_id ?? e.$distinct_id;
  if (typeof did === 'number') did = String(did);
  if (typeof did !== 'string' || !did.trim() || did.length > 200) return { drop: 'invalid_distinct_id' };
  const options = obj(e.options) ?? {};
  // Settings: v1 options win over legacy $ properties.
  const ppOpt = bool(options.process_person_profile);
  const person = ppOpt ?? (properties.$process_person_profile === false ? false : true);
  properties.$process_person_profile = person;
  const ignoreSentAt = bool(options.disable_skew_correction) ?? (opts.v1 ? false : properties.$ignore_sent_at === true);
  if (typeof e.session_id === 'string' && !properties.$session_id) properties.$session_id = e.session_id;
  if (typeof e.window_id === 'string' && !properties.$window_id) properties.$window_id = e.window_id;
  // Person property updates may be top level or in properties; top level wins.
  const set = { ...(obj(properties.$set) ?? {}), ...(obj(e.$set) ?? {}) };
  const setOnce = { ...(obj(properties.$set_once) ?? {}), ...(obj(e.$set_once) ?? {}) };
  const unset = Array.isArray(properties.$unset) ? properties.$unset.filter((x): x is string => typeof x === 'string') : [];
  if (Object.keys(set).length) properties.$set = set;
  if (Object.keys(setOnce).length) properties.$set_once = setOnce;
  delete properties.token; delete properties.distinct_id;
  if (ctx.libHeader && (typeof properties.$lib !== 'string' || !properties.$lib)) { properties.$lib = ctx.libHeader[0]; properties.$lib_version = ctx.libHeader[1]; }
  if (ctx.ip && !opts.anonymizeIps && properties.$ip === undefined) properties.$ip = ctx.ip;
  if (opts.anonymizeIps) delete properties.$ip;
  // Location comes from Cloudflare's view of the request, unless the client opted out or already sent its own $geoip_* values (imports).
  if (properties.$geoip_disable !== true && !Object.keys(properties).some(k => k.startsWith('$geoip_'))) Object.assign(properties, ctx.geo);
  const { ts } = parseEventTimestamp(e.timestamp, opts.v1 ? undefined : e.offset, ctx.sentAt, ignoreSentAt, ctx.now);
  const uuid = isUuid(e.uuid) ? e.uuid.toLowerCase() : uuidv7(ts);
  const out: NormEvent = { uuid, event, distinct_id: did, ts, properties, person, received_at: ctx.now };
  if (Object.keys(set).length) out.set = set;
  if (Object.keys(setOnce).length) out.set_once = setOnce;
  if (unset.length) out.unset = unset;
  return out;
}

/** Sends normalized events onward: queue messages under the size budget; an event too big for a message goes straight to the store. */
export async function enqueue(env: Env, pid: number, events: NormEvent[]): Promise<void> {
  const msgs: IngestMsg[] = []; let cur: NormEvent[] = []; let size = 0; const direct: NormEvent[] = [];
  for (const ev of events) {
    const n = JSON.stringify(ev).length;
    if (n > MSG_BUDGET) { direct.push(ev); continue; }
    if (size + n > MSG_BUDGET && cur.length) { msgs.push({ pid, events: cur }); cur = []; size = 0; }
    cur.push(ev); size += n;
  }
  if (cur.length) msgs.push({ pid, events: cur });
  for (let i = 0; i < msgs.length; i += 2) await env.INGEST.sendBatch(msgs.slice(i, i + 2).map(body => ({ body, contentType: 'json' as const })));
  if (direct.length) await storeFor(env, pid).ingest(direct, pid);
}

function reqCtx(req: Request, sentAt: number | null): Ctx {
  return { now: Date.now(), sentAt, ip: req.headers.get('cf-connecting-ip'), geo: geoProps(req) };
}

export async function handleLegacyCapture(req: Request, env: Env, url: URL, ectx?: ExecutionContext): Promise<Response> {
  let bytes: Uint8Array;
  if (req.method === 'GET') {
    const d = url.searchParams.get('data');
    if (!d) return err(req, 400, 'no_data', 'No data found. Make sure to use a POST request when sending the payload in the body.');
    bytes = new TextEncoder().encode(d);
  } else bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return err(req, 400, 'no_data', 'Empty request body.');
  let payload: any;
  try {
    const text = await decodeBody(bytes, { compression: url.searchParams.get('compression'), contentType: req.headers.get('content-type'), contentEncoding: req.headers.get('content-encoding') });
    payload = JSON.parse(text);
  } catch (e) {
    if (e instanceof DecodeError && e.code === 'payload_too_large') return err(req, 413, 'payload_too_large', 'Payload too large.');
    return err(req, 400, 'invalid_payload', 'Malformed request data: ' + (e instanceof Error ? e.message : 'invalid'));
  }
  let rawEvents: unknown[]; let token: unknown; let sentAt: number | null = null; const path = url.pathname.replace(/\/$/, '');
  if (Array.isArray(payload)) rawEvents = payload;
  else if (obj(payload) && Array.isArray(payload.batch)) { rawEvents = payload.batch; token = payload.api_key ?? payload.token; sentAt = parseDate(payload.sent_at); }
  else if (obj(payload) && typeof payload.event === 'string') rawEvents = [payload];
  else if (obj(payload) && path === '/engage' && (payload.$set || payload.$set_once)) rawEvents = [{ ...payload, event: '$identify' }];
  else return err(req, 400, 'invalid_payload', 'Malformed request data: no events.');
  if (!rawEvents.length) return err(req, 400, 'empty_batch', 'request holds no event');
  const first = obj(rawEvents[0]) ?? {};
  token ??= first.api_key ?? first.token ?? obj(first.properties)?.token ?? url.searchParams.get('token') ?? url.searchParams.get('api_key');
  if (token === undefined || token === null || token === '') return err(req, 401, 'no_token', 'event submitted without an api_key', 'authentication_error');
  if (!validToken(token)) return err(req, 401, 'invalid_token', 'API key is not valid', 'authentication_error');
  if (sentAt === null) { const q = Number(url.searchParams.get('_')); if (Number.isFinite(q) && q > Date.UTC(2021, 0, 1)) sentAt = q; }
  const project = await projectByToken(env, token);
  const beacon = url.searchParams.get('beacon') === '1';
  let quota: string[] | null = null;
  // Over the monthly cap in drop mode, answer with posthog-js's `quota_limited` list so the SDK pauses those batch
  // types for a minute (protocol.md "Quota limiting").
  const ok = () => beacon ? new Response(null, { status: 204, headers: cors(req) }) : json(quota ? { status: 1, quota_limited: quota } : { status: 1 }, 200, cors(req));
  if (!project) return ok(); // unknown project: accepted and dropped, as the reference service does
  const ctx = reqCtx(req, sentAt);
  const events: NormEvent[] = [];
  const aiOnly = path === AI_BATCH_PATH;
  for (const r of rawEvents) { if (aiOnly && !isAiEvent(obj(r)?.event)) continue; const n = normalize(r, ctx, { v1: false, anonymizeIps: !!project.anonymize_ips }); if (!('drop' in n)) events.push(n); }
  const g = gateEvents(project, events, ctx.now); quota = g.quotaLimited;
  meterCap(env, ectx, project.id, g.capDropped, g.keep.length);
  if (g.keep.length) await enqueue(env, project.id, g.keep);
  return ok();
}

export async function handleV1Capture(req: Request, env: Env, ectx?: ExecutionContext, aiOnly = false): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const m = /^(\S+)\s+(.+)$/.exec(auth);
  if (!m) return err(req, 401, 'invalid_api_key', 'Missing Authorization header.', 'authentication_error');
  if (m[1].toLowerCase() !== 'bearer') return err(req, 400, 'invalid_auth_scheme', 'Use Authorization: Bearer <project token>.');
  const token = m[2].trim();
  if (!validToken(token)) return err(req, 401, 'invalid_api_key', 'Project token invalid.', 'authentication_error');
  const ce = (req.headers.get('content-encoding') ?? '').toLowerCase().trim();
  if (ce && ce !== 'gzip' && ce !== 'deflate') return err(req, 415, 'unsupported_encoding', `Content-Encoding ${ce} is not supported.`);
  let body: any;
  try { body = JSON.parse(await decodeBody(new Uint8Array(await req.arrayBuffer()), { contentEncoding: ce })); }
  catch (e) { return err(req, e instanceof DecodeError && e.code === 'payload_too_large' ? 413 : 400, 'invalid_payload', 'Body is not valid JSON.'); }
  if (!obj(body) || !Array.isArray(body.batch) || !body.batch.length) return err(req, 400, 'invalid_payload', 'Body needs a non-empty batch.');
  for (const ev of body.batch) if (obj(ev)?.uuid !== undefined && !isUuid(obj(ev)!.uuid)) return err(req, 400, 'invalid_uuid', 'Every uuid must be a UUID.');
  const sdk = /^([^/\s]+)\/(\S+)$/.exec(req.headers.get('posthog-sdk-info') ?? '');
  const ctx = { ...reqCtx(req, parseDate(body.created_at)), libHeader: sdk ? [sdk[1], sdk[2]] as [string, string] : undefined };
  if (body.capture_internal === true) ctx.ip = '127.0.0.1';
  const project = await projectByToken(env, token);
  const results: Record<string, { result: string; details?: string; duplicates_dropped?: number }> = {};
  const seen = new Map<string, number>();
  const events: NormEvent[] = [];
  for (const raw of body.batch) {
    const id = String(obj(raw)?.uuid ?? '').toLowerCase();
    if (id && seen.has(id)) { seen.set(id, seen.get(id)! + 1); results[id].duplicates_dropped = seen.get(id)! - 1; continue; }
    const n = normalize(raw, ctx, { v1: true, anonymizeIps: !!project?.anonymize_ips });
    const key = id || ('drop' in n ? uuidv7() : n.uuid);
    seen.set(key, 1);
    if ('drop' in n) { results[key] = { result: 'drop', details: n.drop }; continue; }
    if (aiOnly && !isAiEvent(n.event)) { results[key] = { result: 'drop', details: 'misrouted_event' }; continue; }
    results[key] = { result: 'ok' };
    if (project) events.push(n);
  }
  let quota: string[] | null = null;
  if (project && events.length) {
    const g = gateEvents(project, events, ctx.now); quota = g.quotaLimited;
    meterCap(env, ectx, project.id, g.capDropped, g.keep.length);
    if (g.keep.length) await enqueue(env, project.id, g.keep);
  }
  return json(quota ? { results, quota_limited: quota } : { results }, 200, cors(req));
}
/** Counts events a spending cap dropped at the edge, and the request when nothing of it was kept. */
function meterCap(env: Env, ectx: ExecutionContext | undefined, pid: number, capDropped: number, kept: number) {
  if (capDropped <= 0) return;
  meter(env, ectx, pid, 'edge_dropped_events', capDropped);
  if (!kept) meter(env, ectx, pid, 'edge_dropped_requests', 1);
}

/**
 * POST /i/v0/ai (protocol.md "LLM analytics"): one `$ai_*` event as multipart/form-data with an `event` part (the event
 * JSON) and an optional `event.properties` part (its properties, merged over the event's own), project token as
 * `Authorization: Bearer`, body optionally gzip (Content-Encoding). Any other part is refused with 400.
 */
export async function handleAiMultipart(req: Request, env: Env, ectx?: ExecutionContext): Promise<Response> {
  const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!auth || !validToken(auth[1])) return err(req, 401, 'invalid_api_key', 'Use Authorization: Bearer <project token>.', 'authentication_error');
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) return err(req, 400, 'invalid_payload', 'Content-Type must be multipart/form-data');
  let bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return err(req, 400, 'no_data', 'Empty request body.');
  if (bytes.length > 25 * 1024 * 1024) return err(req, 413, 'payload_too_large', 'Payload too large.');
  const ce = (req.headers.get('content-encoding') ?? '').toLowerCase().trim();
  try { if (ce === 'gzip') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
  catch { return err(req, 400, 'invalid_payload', 'Body is not valid gzip.'); }
  let form: FormData;
  try { form = await new Response(bytes, { headers: { 'content-type': ct } }).formData(); }
  catch { return err(req, 400, 'invalid_payload', 'Malformed multipart body.'); }
  const names = [...new Set([...form.keys()])];
  const bad = names.find(n => n !== 'event' && n !== 'event.properties');
  if (bad) return err(req, 400, 'invalid_payload', `Unknown multipart part ${bad.slice(0, 80)}; only event and event.properties are accepted.`);
  if (form.getAll('event').length !== 1 || form.getAll('event.properties').length > 1) return err(req, 400, 'invalid_payload', 'Send exactly one event part and at most one event.properties part.');
  const text = async (v: string | File | null) => v === null ? null : typeof v === 'string' ? v : await v.text();
  let event: any; let props: any = null;
  try { event = JSON.parse((await text(form.get('event')))!); const pt = await text(form.get('event.properties')); if (pt !== null) props = JSON.parse(pt); }
  catch { return err(req, 400, 'invalid_payload', 'The event and event.properties parts must be JSON.'); }
  if (!obj(event) || (props !== null && !obj(props))) return err(req, 400, 'invalid_payload', 'The event part must be a JSON object.');
  if (!isAiEvent(event.event)) return err(req, 400, 'misrouted_event', 'Only $ai_* events are accepted here.');
  if (event.uuid !== undefined && !isUuid(event.uuid)) return err(req, 400, 'invalid_uuid', 'uuid must be a UUID.');
  const project = await projectByToken(env, auth[1]);
  if (!project) return json({ status: 1 }, 200, cors(req));
  const ctx = reqCtx(req, null);
  const n = normalize({ ...event, properties: { ...(obj(event.properties) ?? {}), ...(props ?? {}) } }, ctx, { v1: true, anonymizeIps: !!project.anonymize_ips });
  if ('drop' in n) return err(req, 400, 'invalid_payload', `Event dropped: ${n.drop}`);
  const g = gateEvents(project, [n], ctx.now);
  meterCap(env, ectx, project.id, g.capDropped, g.keep.length);
  if (g.keep.length) await enqueue(env, project.id, g.keep);
  return json(g.quotaLimited ? { status: 1, quota_limited: g.quotaLimited } : { status: 1 }, 200, cors(req));
}
