// Worker entry: routing, the ingest queue consumer and the daily retention cron (spec R1).
import { coldRecord } from './cold';
import { Env, HttpError, IngestMsg, ingestHost, json, origin, storeFor, ProjectRow } from './env';
import { handleLegacyCapture, handleV1Capture, LEGACY_PATHS, V1_PATH, cors } from './capture';
import { handleConfig, handleFlags, handleStub, handleSurveys, handleLocalEvaluation } from './sdk';
import { handleApi } from './api';
import { handleSnapshots, chunkPrefix, deletePrefix } from './replay';
import ui from './ui.gen';
export { ProjectStore } from './store';
export { EventShard } from './shard';

const HOURLY = '41 * * * *';
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const bare = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (LEGACY_PATHS.has(bare) && (req.method === 'POST' || req.method === 'GET')) return handleLegacyCapture(req, env, url);
  if (bare === V1_PATH && req.method === 'POST') return handleV1Capture(req, env);
  if (bare === '/s' || bare === '/i/v0/s') return handleSnapshots(req, env, url);
  if (bare === '/flags/definitions' || bare === '/api/feature_flag/local_evaluation') return handleLocalEvaluation(req, env, url);
  if (bare === '/flags' || bare === '/decide') return handleFlags(req, env, url, bare === '/decide');
  const cfg = /^\/array\/([^/]+)\/config(\.js)?$/.exec(path);
  if (cfg && req.method === 'GET') return handleConfig(req, env, decodeURIComponent(cfg[1]), !!cfg[2]);
  if (path.startsWith('/static/')) {
    // posthog-js first asks for /static/<sdk version>/<file>; serve the bundled copy for any version.
    const u = new URL(req.url); u.pathname = path.replace(/^\/static\/\d+\.\d+\.\d+[^/]*\//, '/static/');
    const r = await env.ASSETS.fetch(new Request(u, req));
    const h = new Headers(r.headers); for (const [k, v] of Object.entries(cors(req))) h.set(k, v);
    if (r.ok) h.set('cache-control', 'public, max-age=3600');
    return new Response(r.body, { status: r.status, headers: h });
  }
  if (bare === '/api/surveys' && req.method === 'GET') return handleSurveys(req, env, url);
  const stub = handleStub(req, bare); if (stub) return stub;
  // Optional ingest-only hostnames (INGEST_HOSTS, design.md "Hostnames"): a first-party ingest subdomain on the site being
  // measured serves only the SDK endpoints above, /_health and personal-API-key calls. Browser pages redirect to SITE_URL,
  // so sign-in, cookies and the Origin check all stay on one origin. Unset (the default): every hostname serves the full app.
  if (ingestHost(env, url) && bare !== '/_health' && !req.headers.get('authorization')) {
    if (req.method === 'GET' || req.method === 'HEAD') return new Response(null, { status: 302, headers: { location: origin(env) + path + url.search, ...SECURITY } });
    return json({ error: 'wrong_host', detail: 'This hostname only receives SDK traffic; the dashboard and owner API are served at SITE_URL.' }, 421);
  }
  if (path.startsWith('/api/')) return handleApi(req, env, url, ui.appName);
  if (path === '/app.js') return new Response(ui.js, { headers: { 'content-type': 'application/javascript', 'cache-control': 'no-cache', ...SECURITY } });
  if (path === '/player.js') return new Response(ui.playerJs, { headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=86400', ...SECURITY } });
  if (path === '/player.css') return new Response(ui.playerCss, { headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=86400', ...SECURITY } });
  if (path === '/app.css') return new Response(ui.css, { headers: { 'content-type': 'text/css', 'cache-control': 'no-cache', ...SECURITY } });
  if (path === '/_health') return json({ ok: true });
  if (req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html')) return new Response(ui.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-frame-options': 'DENY', ...SECURITY } });
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try { return await route(req, env); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, detail: e.message }, e.status);
      console.error('unhandled', e instanceof Error ? e.message : String(e));
      return json({ error: 'internal_error' }, 500);
    }
  },
  async queue(batch: MessageBatch<IngestMsg>, env: Env): Promise<void> {
    const byProject = new Map<number, Message<IngestMsg>[]>();
    for (const m of batch.messages) { const a = byProject.get(m.body.pid) ?? []; a.push(m); byProject.set(m.body.pid, a); }
    await Promise.all([...byProject].map(async ([pid, msgs]) => {
      try {
        const store = storeFor(env, pid);
        const events = msgs.flatMap(m => m.body.events ?? []); const replay = msgs.flatMap(m => m.body.replay ?? []);
        if (events.length) {
          const r = await store.ingest(events, pid);
          // Cold tier: at-least-once copy of every stored event into the Basin stream (design.md "Cold tier"); events
          // dropped over the cap are left out and exceptions go in enriched (symbolicated, with their issue id).
          if (env.COLD_STREAM) {
            const gone = new Set(r.dropped); const enriched = new Map(r.exceptions.map(e => [e.uuid, e]));
            const keep = events.filter(e => !gone.has(e.uuid)).map(e => enriched.get(e.uuid) ?? e);
            if (keep.length) await env.COLD_STREAM.send(keep.map(e => coldRecord(pid, e)));
          }
        }
        if (replay.length) {
          const r = await store.recordReplay(replay, pid);
          if (r.rejected.length) await env.REPLAY.delete(r.rejected);
        }
        msgs.forEach(m => m.ack());
      }
      catch (e) { console.error('ingest failed', pid, e instanceof Error ? e.message : String(e)); msgs.forEach(m => m.retry({ delaySeconds: 10 })); }
    }));
  },
  async scheduled(c: ScheduledController, env: Env): Promise<void> {
    // Hourly: recompute dynamic cohorts (design.md "Cohorts"). Daily: retention.
    if (c.cron === HOURLY) {
      for (const p of (await env.DB.prepare('SELECT id FROM projects').all<{ id: number }>()).results) { try { await storeFor(env, p.id).calculateAllCohorts(); } catch (e) { console.error('cohorts', p.id, e instanceof Error ? e.message : String(e)); } }
      return;
    }
    // Usage spike alerts (design.md "Alerts"): yesterday (UTC) against the 7 days before.
    for (const p of (await env.DB.prepare('SELECT id FROM projects').all<{ id: number }>()).results) { try { await storeFor(env, p.id).checkSpike(p.id); } catch (e) { console.error('spike', p.id, e instanceof Error ? e.message : String(e)); } }
    const rows = (await env.DB.prepare('SELECT * FROM projects WHERE retention_days > 0').all<ProjectRow>()).results;
    for (const p of rows) await storeFor(env, p.id).purge(Date.now() - p.retention_days * 86400_000);
    // Recordings: REPLAY_RETENTION_DAYS (default 30), never longer than the project's event retention.
    const rdays = Math.max(0, Math.floor(Number(env.REPLAY_RETENTION_DAYS ?? '30') || 0));
    for (const p of (await env.DB.prepare('SELECT * FROM projects').all<ProjectRow>()).results) {
      const days = [rdays, p.retention_days].filter(d => d > 0); if (!days.length) continue;
      const gone = await storeFor(env, p.id).expireRecordings(Date.now() - Math.min(...days) * 86400_000);
      for (const sid of gone) await deletePrefix(env, chunkPrefix(p.id, sid));
    }
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
  },
} satisfies ExportedHandler<Env, IngestMsg>;
