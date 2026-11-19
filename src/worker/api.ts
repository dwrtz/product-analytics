// Owner API under /api (spec R7-R12). Session cookie or personal API key.
import { Env, HttpError, json, nowIso, origin, ProjectRow, storeFor } from './env';
import { authenticate, createPersonalKey, login, logout, signup, signupOpen } from './auth';
import { randomToken } from '../shared/ids';
import { forgetToken } from './projects';
import { QueryError } from './query';
import { chunkPrefix, deletePrefix, readSnapshots, readSnapshotsPage, cleanReplayConfig, ReplayConfigError } from './replay';
import { handleLocalEvaluation } from './sdk';
import { coldEnabled, runColdSql } from './cold';
import { cleanLimits, limitsOf, capStateOf, LimitsError, NEW_PROJECT_LIMITS, NEW_PROJECT_REPLAY_SAMPLE_RATE } from './usage';
import { validateMap } from '../shared/sourcemap';
import { refOf } from './errors';
import { uuidv7 } from '../shared/ids';

const readJson = async (req: Request) => { try { return await req.json() as any; } catch { throw new HttpError(400, 'bad_request', 'Body must be JSON.'); } };
const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

export async function handleApi(req: Request, env: Env, url: URL, appName: string): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  if (path === '/api/config' && m === 'GET') return json({ app_name: appName, site_url: origin(env), signup_open: await signupOpen(env), cold_tier: coldEnabled(env) });
  const cookieAuthWrite = m !== 'GET' && m !== 'HEAD' && !req.headers.get('authorization');
  if (cookieAuthWrite && req.headers.get('origin') !== origin(env)) throw new HttpError(403, 'bad_origin', 'Origin does not match SITE_URL.');
  if (path === '/api/signup' && m === 'POST') { const r = await signup(env, await readJson(req)); return json({ ok: true }, 201, { 'set-cookie': r.cookie }); }
  if (path === '/api/login' && m === 'POST') { const r = await login(env, await readJson(req)); return json({ ok: true }, 200, { 'set-cookie': r.cookie }); }
  if (path === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': await logout(env, req) });

  const auth = await authenticate(env, req);
  if (!auth) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
  const user = auth.user;
  if (path === '/api/me' && m === 'GET') return json({ id: user.id, email: user.email, name: user.name });

  if (path === '/api/personal_api_keys') {
    if (m === 'GET') return json((await env.DB.prepare('SELECT id, label, mask, created_at, last_used_at FROM personal_api_keys WHERE user_id = ? ORDER BY id DESC').bind(user.id).all()).results);
    if (m === 'POST') { const b = await readJson(req); const key = await createPersonalKey(env, user.id, String(b.label ?? '')); return json({ key }, 201); }
  }
  let mm = /^\/api\/personal_api_keys\/(\d+)$/.exec(path);
  if (mm && m === 'DELETE') { await env.DB.prepare('DELETE FROM personal_api_keys WHERE id = ? AND user_id = ?').bind(+mm[1], user.id).run(); return json({ ok: true }); }

  if (path === '/api/projects') {
    if (m === 'GET') return json((await env.DB.prepare('SELECT * FROM projects ORDER BY id').all<ProjectRow>()).results.map(projectOut));
    if (m === 'POST') {
      const b = await readJson(req);
      const name = String(b.name ?? '').trim().slice(0, 100) || 'Default project';
      const tz = String(b.timezone ?? 'UTC'); if (!validTz(tz)) throw new HttpError(400, 'bad_request', 'Unknown time zone.');
      const days = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
      const ret = b.retention_days !== undefined ? days(b.retention_days) : days(env.DEFAULT_RETENTION_DAYS);
      // 0.5 defaults (design.md "Usage limits"): monthly caps, autocapture and replay sampling, exception autocapture on.
      const r = await env.DB.prepare('INSERT INTO projects (name, api_token, timezone, retention_days, created_at, limits, replay_config, error_tracking) VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING *')
        .bind(name, randomToken('phc_', 43), tz, ret, nowIso(), JSON.stringify(NEW_PROJECT_LIMITS), JSON.stringify(cleanReplayConfig({ sample_rate: NEW_PROJECT_REPLAY_SAMPLE_RATE }))).first<ProjectRow>();
      return json(projectOut(r!), 201);
    }
  }
  mm = /^\/api\/projects\/(\d+)(\/.*)?$/.exec(path);
  if (!mm) throw new HttpError(404, 'not_found');
  const pid = +mm[1]; const sub = mm[2] ?? '';
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(pid).first<ProjectRow>();
  if (!project) throw new HttpError(404, 'not_found', 'No such project.');
  const store = storeFor(env, pid);
  const qc = { timezone: project.timezone };

  if (sub === '') {
    if (m === 'GET') return json(projectOut(project));
    if (m === 'PATCH') {
      const b = await readJson(req);
      const name = b.name !== undefined ? String(b.name).trim().slice(0, 100) || project.name : project.name;
      const tz = b.timezone !== undefined ? String(b.timezone) : project.timezone; if (!validTz(tz)) throw new HttpError(400, 'bad_request', 'Unknown time zone.');
      const ret = b.retention_days !== undefined ? Math.max(0, Math.floor(Number(b.retention_days) || 0)) : project.retention_days;
      const anon = b.anonymize_ips !== undefined ? (b.anonymize_ips ? 1 : 0) : project.anonymize_ips;
      const ac = b.autocapture_opt_out !== undefined ? (b.autocapture_opt_out ? 1 : 0) : project.autocapture_opt_out;
      const rec = b.session_recording !== undefined ? (b.session_recording ? 1 : 0) : (project.session_recording ?? 0);
      const hm = b.heatmaps !== undefined ? (b.heatmaps ? 1 : 0) : (project.heatmaps ?? 0);
      let rc = project.replay_config ?? null;
      if (b.replay_config !== undefined) { try { rc = b.replay_config === null ? null : JSON.stringify(cleanReplayConfig(b.replay_config)); } catch (e) { if (e instanceof ReplayConfigError) throw new HttpError(400, 'bad_request', e.message); throw e; } }
      let lim = project.limits ?? null;
      if (b.limits !== undefined) { try { lim = b.limits === null ? null : JSON.stringify(cleanLimits(b.limits, limitsOf(project))); } catch (e) { if (e instanceof LimitsError) throw new HttpError(400, 'bad_request', e.message); throw e; } }
      const et = b.error_tracking !== undefined ? (b.error_tracking ? 1 : 0) : (project.error_tracking ?? 0);
      let r = await env.DB.prepare('UPDATE projects SET name = ?, timezone = ?, retention_days = ?, anonymize_ips = ?, autocapture_opt_out = ?, session_recording = ?, heatmaps = ?, replay_config = ?, limits = ?, error_tracking = ? WHERE id = ? RETURNING *').bind(name, tz, ret, anon, ac, rec, hm, rc, lim, et, pid).first<ProjectRow>();
      if (b.limits !== undefined) { await store.refreshCaps(pid); r = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(pid).first<ProjectRow>(); }
      forgetToken(project.api_token);
      return json(projectOut(r!));
    }
    if (m === 'DELETE') {
      await store.destroy(); await deletePrefix(env, chunkPrefix(pid)); await deletePrefix(env, `sourcemaps/${pid}/`); await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(pid).run(); forgetToken(project.api_token); return json({ ok: true });
    }
  }
  if (sub === '/reset_token' && m === 'POST') {
    const r = await env.DB.prepare('UPDATE projects SET api_token = ? WHERE id = ? RETURNING *').bind(randomToken('phc_', 43), pid).first<ProjectRow>();
    forgetToken(project.api_token); return json(projectOut(r!));
  }
  const asQueryError = (e: unknown): never => { const msg = e instanceof Error ? e.message : String(e); if (e instanceof QueryError || /unsupported|needs|must|at least|at most|unknown|bad |not supported|not allowed|expected|unexpected|timed out|too many|too long|cannot/.test(msg)) throw new HttpError(400, 'invalid_query', msg); throw e; };
  if (sub === '/query' && m === 'POST') {
    const b = await readJson(req);
    try { return json(await store.query(b.query ?? b, qc)); } catch (e) { return asQueryError(e); }
  }
  // SQL editor (design.md "SQL"): read-only SELECT over events and persons.
  if (sub === '/sql' && m === 'POST') {
    const b = await readJson(req); if (typeof b.query !== 'string' || !b.query.trim()) throw new HttpError(400, 'bad_request', 'query (a SELECT statement) is required.');
    if (b.source === 'cold') { try { return json(await runColdSql(env, b.query, { projectId: pid, retentionDays: project.retention_days })); } catch (e) { return asQueryError(e); } }
    try { return json(await store.sqlQuery(b.query, qc)); } catch (e) { return asQueryError(e); }
  }
  if ((sub === '/heatmaps' || sub === '/heatmaps/urls' || sub === '/scroll_depth') && m === 'GET') {
    const q = Object.fromEntries(url.searchParams);
    try { return json(sub === '/heatmaps' ? await store.heatmap(q) : sub === '/heatmaps/urls' ? await store.heatmapUrls(q) : await store.scrollDepth(q)); } catch (e) { return asQueryError(e); }
  }
  if (sub === '/feature_flags/local_evaluation') return handleLocalEvaluation(req, env, url, project);
  if (sub === '/events' && m === 'GET') {
    const props = url.searchParams.get('properties');
    return json(await store.query({ kind: 'EventsQuery', event: url.searchParams.get('event') || undefined, personId: url.searchParams.get('person_id') || undefined, cursor: url.searchParams.get('cursor') || undefined, limit: Number(url.searchParams.get('limit')) || 100, properties: props ? JSON.parse(props) : [] }, qc));
  }
  if (sub === '/definitions' && m === 'GET') return json(await store.definitions());
  if (sub === '/property_values' && m === 'GET') return json(await store.propertyValues(url.searchParams.get('type') === 'person' ? 'person' : 'event', String(url.searchParams.get('key') ?? '')));
  if (sub === '/stats' && m === 'GET') return json(await store.stats());
  if (sub === '/persons' && m === 'GET') return json(await store.listPersons(url.searchParams.get('search') ?? '', url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : null));
  let s = /^\/persons\/([^/]+)$/.exec(sub);
  if (s) {
    if (m === 'GET') { const p = await store.getPerson(decodeURIComponent(s[1])); if (!p) throw new HttpError(404, 'not_found'); return json(p); }
    if (m === 'DELETE') {
      const ok = await store.deletePerson(decodeURIComponent(s[1]), url.searchParams.get('delete_events') === '1'); if (!ok) throw new HttpError(404, 'not_found');
      for (const sid of ok.recordings) await deletePrefix(env, chunkPrefix(pid, sid));
      return json({ ok: true });
    }
  }
  if (sub === '/insights') {
    if (m === 'GET') return json(await store.listInsights());
    if (m === 'POST') { const b = await readJson(req); return json(await store.saveInsight(null, b, user.email), 201); }
  }
  s = /^\/insights\/([^/]+)$/.exec(sub);
  if (s) {
    if (m === 'GET') { const i = await store.getInsight(s[1]); if (!i) throw new HttpError(404, 'not_found'); return json(i); }
    if (m === 'PATCH') { const i = await store.saveInsight(s[1], await readJson(req), user.email); if (!i) throw new HttpError(404, 'not_found'); return json(i); }
    if (m === 'DELETE') { if (!await store.deleteInsight(s[1])) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
  }
  if (sub === '/dashboards') {
    if (m === 'GET') return json(await store.listDashboards());
    if (m === 'POST') return json(await store.saveDashboard(null, await readJson(req)), 201);
  }
  s = /^\/dashboards\/(\d+)$/.exec(sub);
  if (s) {
    if (m === 'GET') { const d = await store.getDashboard(+s[1]); if (!d) throw new HttpError(404, 'not_found'); return json(d); }
    if (m === 'PATCH') { const d = await store.saveDashboard(+s[1], await readJson(req)); if (!d) throw new HttpError(404, 'not_found'); return json(d); }
    if (m === 'DELETE') { if (!await store.deleteDashboard(+s[1])) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
  }
  s = /^\/dashboards\/(\d+)\/tiles$/.exec(sub);
  if (s && m === 'POST') { const b = await readJson(req); if (!await store.addTile(+s[1], Number(b.insight_id))) throw new HttpError(404, 'not_found'); return json({ ok: true }, 201); }
  s = /^\/dashboards\/(\d+)\/tiles\/(\d+)$/.exec(sub);
  if (s && m === 'DELETE') { if (!await store.removeTile(+s[1], +s[2])) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
  if (sub === '/actions') {
    if (m === 'GET') return json(await store.listActions());
    if (m === 'POST') { const r = await store.saveAction(null, await readJson(req)); if ('error' in r) throw new HttpError(400, 'bad_request', r.error); return json(r, 201); }
  }
  s = /^\/actions\/(\d+)$/.exec(sub);
  if (s) {
    if (m === 'GET') { const a = await store.getAction(+s[1]); if (!a) throw new HttpError(404, 'not_found'); return json(a); }
    if (m === 'PATCH') { const r = await store.saveAction(+s[1], await readJson(req)); if ('error' in r) throw new HttpError(r.error === 'not_found' ? 404 : 400, r.error === 'not_found' ? 'not_found' : 'bad_request', r.error); return json(r); }
    if (m === 'DELETE') { if (!await store.deleteAction(+s[1])) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
  }
  if (sub === '/cohorts') {
    if (m === 'GET') return json(await store.listCohorts());
    if (m === 'POST') { const r = await store.saveCohort(null, await readCohortBody(req)); if ('error' in r) throw new HttpError(400, 'bad_request', r.error); return json(r, 201); }
  }
  s = /^\/cohorts\/(\d+)(\/persons|\/calculate)?(?:\/([^/]+))?$/.exec(sub);
  if (s) {
    const id = +s[1];
    if (!s[2]) {
      if (m === 'GET') { const c = await store.getCohort(id); if (!c) throw new HttpError(404, 'not_found'); return json(c); }
      if (m === 'PATCH') { const r = await store.saveCohort(id, await readCohortBody(req)); if ('error' in r) throw new HttpError(r.error === 'not_found' ? 404 : 400, r.error === 'not_found' ? 'not_found' : 'bad_request', r.error); return json(r); }
      if (m === 'DELETE') { if (!await store.deleteCohort(id)) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
    }
    if (s[2] === '/calculate' && m === 'POST') { if (!await store.getCohort(id)) throw new HttpError(404, 'not_found'); try { await store.calculateCohort(id); } catch (e) { return asQueryError(e); } return json(await store.getCohort(id)); }
    if (s[2] === '/persons' && !s[3] && m === 'GET') { if (!await store.getCohort(id)) throw new HttpError(404, 'not_found'); return json(await store.cohortPersons(id, url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : null)); }
    if (s[2] === '/persons' && !s[3] && m === 'POST') { const r = await store.addCohortPersons(id, await readCohortBody(req)); if ('error' in r) throw new HttpError(r.error === 'not_found' ? 404 : 400, r.error === 'not_found' ? 'not_found' : 'bad_request', r.error as string); return json(r); }
    if (s[2] === '/persons' && s[3] && m === 'DELETE') { if (!await store.removeCohortPerson(id, decodeURIComponent(s[3]))) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
  }
  if (sub === '/feature_flags') {
    if (m === 'GET') return json(await store.listFlags(url.searchParams.get('include_internal') === '1'));
    if (m === 'POST') { const r = await store.saveFlag(null, await readJson(req)); if ('error' in r) throw new HttpError(400, 'bad_request', r.error); return json(r, 201); }
  }
  s = /^\/feature_flags\/(\d+)$/.exec(sub);
  if (s) {
    if (m === 'GET') { const f = await store.getFlag(+s[1]); if (!f) throw new HttpError(404, 'not_found'); return json(f); }
    if (m === 'PATCH') { const r = await store.saveFlag(+s[1], await readJson(req)); if ('error' in r) throw new HttpError(r.error === 'not_found' ? 404 : 400, r.error === 'not_found' ? 'not_found' : 'bad_request', r.error); return json(r); }
    if (m === 'DELETE') { if (!await store.deleteFlag(+s[1])) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
  }
  if (sub === '/experiments') {
    if (m === 'GET') return json(await store.listExperiments());
    if (m === 'POST') { const r = await store.saveExperiment(null, await readJson(req)); if ('error' in r) throw new HttpError(400, 'bad_request', r.error); return json(r, 201); }
  }
  s = /^\/experiments\/(\d+)(\/results)?$/.exec(sub);
  if (s) {
    if (s[2] && m === 'GET') { const r = await store.experimentResults(+s[1]); if (!r) throw new HttpError(404, 'not_found'); return json(r); }
    if (!s[2] && m === 'GET') { const e = await store.getExperiment(+s[1]); if (!e) throw new HttpError(404, 'not_found'); return json(e); }
    if (!s[2] && m === 'PATCH') { const r = await store.saveExperiment(+s[1], await readJson(req)); if ('error' in r) throw new HttpError(r.error === 'not_found' ? 404 : 400, r.error === 'not_found' ? 'not_found' : 'bad_request', r.error); return json(r); }
    if (!s[2] && m === 'DELETE') { if (!await store.deleteExperiment(+s[1])) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
  }
  if (sub === '/surveys') {
    if (m === 'GET') return json(await store.listSurveys());
    if (m === 'POST') { const r = await store.saveSurvey(null, await readJson(req)); if ('error' in r) throw new HttpError(400, 'bad_request', r.error); return json(r, 201); }
  }
  s = /^\/surveys\/([\w-]+)(\/results)?$/.exec(sub);
  if (s) {
    if (s[2] && m === 'GET') { const it = Number(url.searchParams.get('iteration')); const r = await store.surveyResults(s[1], Number.isInteger(it) && it > 0 ? it : null); if (!r) throw new HttpError(404, 'not_found'); return json(r); }
    if (!s[2] && m === 'GET') { const e = await store.getSurvey(s[1]); if (!e) throw new HttpError(404, 'not_found'); return json(e); }
    if (!s[2] && m === 'PATCH') { const r = await store.saveSurvey(s[1], await readJson(req)); if ('error' in r) throw new HttpError(r.error === 'not_found' ? 404 : 400, r.error === 'not_found' ? 'not_found' : 'bad_request', r.error); return json(r); }
    if (!s[2] && m === 'DELETE') { if (!await store.deleteSurvey(s[1])) throw new HttpError(404, 'not_found'); return json({ ok: true }); }
  }
  // ---------- 0.5: usage, alerts, error tracking ----------
  if (sub === '/usage' && m === 'GET') return json(await store.usage(pid, Number(url.searchParams.get('days')) || 30));
  if (sub === '/alerts' && m === 'GET') return json(await store.listAlerts(Number(url.searchParams.get('limit')) || 50));
  if (sub === '/alerts/read' && m === 'POST') return json(await store.markAlertsRead());
  if (sub === '/alerts/test' && m === 'POST') return json(await store.testAlert(pid));
  if (sub === '/error_issues' && m === 'GET') return json(await store.listIssues({ status: url.searchParams.get('status'), search: url.searchParams.get('search'), order: url.searchParams.get('order'), limit: Number(url.searchParams.get('limit')) || 100 }));
  s = /^\/error_issues\/([0-9a-f-]{36})$/.exec(sub);
  if (s) {
    if (m === 'GET') { const r = await store.getIssue(s[1]); if (!r) throw new HttpError(404, 'not_found'); return json(r); }
    if (m === 'PATCH') { const r = await store.updateIssue(s[1], await readJson(req)); if (!r) throw new HttpError(404, 'not_found'); if ('error' in r) throw new HttpError(400, 'bad_request', r.error as string); return json(r); }
  }
  // Source maps (design.md "Source maps"): PUT/POST ?url=<URL of the minified file> with the map JSON as the body.
  if (sub === '/symbol_sets') {
    if (m === 'GET') return json(await store.listSymbolSets());
    if (m === 'POST' || m === 'PUT') {
      const ref = refOf(url.searchParams.get('url') ?? '');
      if (!ref || ref.length > 2000) throw new HttpError(400, 'bad_request', 'url (the minified file URL or path the stack frames show) is required.');
      const text = await req.text();
      if (text.length > 25 * 1024 * 1024) throw new HttpError(413, 'payload_too_large', 'Source map over 25 MB.');
      let map: unknown; try { map = JSON.parse(text); } catch { throw new HttpError(400, 'bad_request', 'Body must be the source map JSON.'); }
      const bad = validateMap(map); if (bad) throw new HttpError(400, 'bad_request', bad);
      const key = `sourcemaps/${pid}/${uuidv7()}.map`;
      await env.REPLAY.put(key, text, { httpMetadata: { contentType: 'application/json' } });
      const r = await store.addSymbolSet(ref, key, text.length);
      if (r.replaced) await env.REPLAY.delete(r.replaced);
      return json({ id: r.id, url: ref, size: text.length, replaced: !!r.replaced }, 201);
    }
  }
  s = /^\/symbol_sets\/([0-9a-f-]{36})$/.exec(sub);
  if (s && m === 'DELETE') { const key = await store.deleteSymbolSet(s[1]); if (!key) throw new HttpError(404, 'not_found'); await env.REPLAY.delete(key); return json({ ok: true }); }
  if (sub === '/session_recordings' && m === 'GET') {
    const before = url.searchParams.get('before');
    return json(await store.listRecordings({ personId: url.searchParams.get('person_id'), distinctId: url.searchParams.get('distinct_id'), before: before ? Number(before) : null, limit: Number(url.searchParams.get('limit')) || 50 }));
  }
  s = /^\/session_recordings\/([^/]+)(\/snapshots)?$/.exec(sub);
  if (s) {
    const sid = decodeURIComponent(s[1]);
    if (s[2] && m === 'GET') {
      const r = await store.getRecording(sid); if (!r) throw new HttpError(404, 'not_found');
      // Paged (?cursor= or ?paged=1): about 16 MB of events per page, with `next` for the following page.
      if (url.searchParams.has('cursor') || url.searchParams.get('paged') === '1') return json(await readSnapshotsPage(env, pid, sid, url.searchParams.get('cursor') || null));
      return json({ snapshots: await readSnapshots(env, pid, sid) });
    }
    if (!s[2] && m === 'GET') { const r = await store.getRecording(sid); if (!r) throw new HttpError(404, 'not_found'); return json(r); }
    if (!s[2] && m === 'DELETE') { if (!await store.deleteRecording(sid)) throw new HttpError(404, 'not_found'); await deletePrefix(env, chunkPrefix(pid, sid)); return json({ ok: true }); }
  }
  throw new HttpError(404, 'not_found');
}
function projectOut(p: ProjectRow) {
  let rc: unknown = null; try { rc = p.replay_config ? JSON.parse(p.replay_config) : null; } catch { rc = null; }
  return { id: p.id, name: p.name, api_token: p.api_token, timezone: p.timezone, retention_days: p.retention_days, anonymize_ips: !!p.anonymize_ips, autocapture_opt_out: !!p.autocapture_opt_out,
    session_recording: !!p.session_recording, replay_config: rc, heatmaps: !!p.heatmaps, limits: p.limits ? limitsOf(p) : null, cap_state: capStateOf(p), error_tracking: !!p.error_tracking, created_at: p.created_at };
}
/** Cohort bodies are JSON, or a CSV upload (text/csv) of distinct ids or emails for a static cohort. */
async function readCohortBody(req: Request) {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('text/csv') || ct.includes('text/plain')) { const t = await req.text(); if (t.length > 20_000_000) throw new HttpError(413, 'payload_too_large', 'CSV over 20 MB.'); return { csv: t }; }
  return readJson(req);
}
