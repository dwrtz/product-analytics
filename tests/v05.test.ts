// 0.5: usage limits, sampling, quota limiting, usage page data, alerts, error tracking and source maps (design.md 0.5
// sections, protocol.md "Quota limiting" and "Exceptions"). Exception payloads are real posthog-js 1.450.1 and
// posthog-node 6.0.3 requests recorded with REA (tests/fixtures/v05-errors.json).
import { describe, it, expect, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import F from './fixtures/v05-errors.json';
import R from './fixtures/snapshot-requests.json';
import { sampled, hashUnit } from '../src/shared/sample';
import { decodeMap, originalPosition, validateMap } from '../src/shared/sourcemap';
import { cleanLimits, NO_LIMITS, gateEvents, estimateCost, LimitsError, NEW_PROJECT_LIMITS } from '../src/worker/usage';
import { fingerprintOf, symbolicate, exceptionList, normalizeFilename, normalizeMessage } from '../src/worker/errors';
import { emailAlert } from '../src/worker/alerts';
import type { ProjectStore } from '../src/worker/store';

const SITE = 'http://app.test';
const E = env as any;
const W = (exports as any).default;
const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set('cookie', init.cookie);
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && !h.has('origin') && path.startsWith('/api/') && !h.has('authorization')) h.set('origin', SITE);
  return W.fetch(new Request(SITE + path, { ...init, headers: h })) as Promise<Response>;
};
async function owner(name = 'V05') {
  const body = JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' });
  let r = await call('/api/signup', { method: 'POST', body });
  if (r.status !== 201) r = await call('/api/login', { method: 'POST', body });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const p = await (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name, timezone: 'UTC' }), cookie })).json() as any;
  return { cookie, p };
}
const patch = async (cookie: string, pid: number, body: unknown) => { const r = await call(`/api/projects/${pid}`, { method: 'PATCH', cookie, body: JSON.stringify(body) }); expect(r.status).toBe(200); return r.json() as any; };
const capture = (token: string, batch: any[]) => call('/i/v0/e/', { method: 'POST', body: JSON.stringify(batch.map(e => ({ ...e, properties: { ...e.properties, token } }))) });
const ev = (event: string, did: string, extra: Record<string, unknown> = {}) => ({ event, distinct_id: did, uuid: crypto.randomUUID(), properties: { $lib: 'web', ...extra } });
const storeOf = (pid: number) => E.STORE.get(E.STORE.idFromName(`project:${pid}`)) as unknown as ProjectStore;
const JS = F.posthog_js_exceptions as any[];
const MIN_URL = 'http://172.17.0.1:8797/app.min.js';

describe('sampling and limits', () => {
  it('samples deterministically by key', () => {
    expect(sampled('a', 1)).toBe(true); expect(sampled('a', 0)).toBe(false);
    expect(sampled('session-1', 0.5)).toBe(sampled('session-1', 0.5));
    const kept = Array.from({ length: 4000 }, (_, i) => sampled('k' + i, 0.25)).filter(Boolean).length;
    expect(kept).toBeGreaterThan(850); expect(kept).toBeLessThan(1150);
    expect(hashUnit('x')).toBeGreaterThanOrEqual(0);
  });
  it('validates limit settings', () => {
    const l = cleanLimits({ events_monthly: '2000', over_cap: 'sample', over_cap_sample_rate: 0.2, alert_emails: 'A@x.io, b@y.io' }, NO_LIMITS);
    expect(l).toMatchObject({ events_monthly: 2000, over_cap: 'sample', over_cap_sample_rate: 0.2, alert_emails: ['a@x.io', 'b@y.io'] });
    expect(cleanLimits({ events_monthly: null }, l).events_monthly).toBeNull();
    expect(() => cleanLimits({ over_cap: 'warn' }, NO_LIMITS)).toThrow(LimitsError);
    expect(() => cleanLimits({ autocapture_sample_rate: 2 }, NO_LIMITS)).toThrow(/0-1/);
    expect(() => cleanLimits({ alert_emails: ['nope'] }, NO_LIMITS)).toThrow(/not an email/);
  });
  it('gates events at the edge: autocapture sampling, then the cap', () => {
    const month = new Date().toISOString().slice(0, 7);
    const p: any = { limits: JSON.stringify({ ...NO_LIMITS, autocapture_sample_rate: 0 }), cap_state: null };
    const evs = [ev('$autocapture', 'u1'), ev('$pageview', 'u1')];
    expect(gateEvents(p, evs).keep.map(e => e.event)).toEqual(['$pageview']);
    p.cap_state = JSON.stringify({ month, events: true, replay: false });
    expect(gateEvents(p, evs)).toEqual({ keep: [], quotaLimited: ['events', 'exceptionEvent'], capDropped: 1 });
    p.cap_state = JSON.stringify({ month: '2001-01', events: true, replay: false });
    expect(gateEvents(p, evs).keep.length).toBe(1); // an old month's state lifts itself
    expect(gateEvents({ limits: null } as any, evs).keep.length).toBe(2); // projects without limits: unchanged
  });
  it('estimates cost at list price, before and after included usage', () => {
    const c = estimateCost({ events: 30e6, event_bytes: 30e6 * 600, requests: 15e6, recordings: 1000, replay_bytes: 2e9, replay_chunks: 100_000, emails: 10, stored_db_bytes: 20 * 1024 ** 3, stored_r2_bytes: 5 * 1024 ** 3, cold_tier: true });
    const line = (k: string) => c.lines.find(l => l.key === k)!;
    expect(line('workers_requests').quantity).toBe(15.1e6);
    expect(line('workers_requests').list_usd).toBeCloseTo(4.53, 2);
    expect(line('workers_requests').after_included_usd).toBeCloseTo(1.53, 2);
    expect(line('do_rows_written').list_usd).toBeCloseTo(240, 0);
    expect(line('do_storage_gb').after_included_usd).toBeCloseTo(3, 5);
    expect(c.after_included_usd).toBeLessThan(c.list_usd);
    expect(c.notes.join(' ')).toMatch(/Estimate/);
  });
});

describe('source maps and fingerprints', () => {
  const map = decodeMap(F.app_min_js_map as any);
  it('decodes VLQ mappings (esbuild map)', () => {
    expect(originalPosition(map, 1, 49)).toMatchObject({ source: 'app-src.js', line: 4, column: 17 });
    expect(originalPosition(map, 1, 159)).toMatchObject({ line: 11, name: 'parsePrice' });
    expect(validateMap({ version: 3, sections: [] })).toMatch(/sections/);
    expect(validateMap({ version: 2, mappings: '', sources: [] })).toMatch(/version 3/);
  });
  it('symbolicates real posthog-js frames, naming functions from their call sites', async () => {
    const { list, resolved } = await symbolicate(exceptionList(JS[0].properties), async f => f === MIN_URL ? map : null);
    expect(resolved).toBe(4);
    const fr = list[0].stacktrace!.frames!;
    expect(fr.map(f => [f.function, f.lineno])).toEqual([['throwUnhandled', 22], ['checkout', 15], ['computeTotal', 11], ['parsePrice', 4]]);
    expect(fr[3]).toMatchObject({ filename: 'app-src.js', resolved: true, context_line: "    const err = new TypeError('Price must be a number, got ' + typeof raw);", minified: { function: 'n', colno: 49 } });
    expect(list[0].stacktrace!.type).toBe('resolved');
  });
  it('fingerprints by type and top frames; custom fingerprints win; messages normalize', async () => {
    const a = await fingerprintOf(JS[0].properties, exceptionList(JS[0].properties));
    const b = await fingerprintOf({}, [{ ...exceptionList(JS[0].properties)[0], value: 'Price must be a number, got object' }]);
    expect(a).toBe(b); expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await fingerprintOf(JS[3].properties, exceptionList(JS[3].properties))).toBe('custom:qty-range');
    expect(normalizeFilename('https://cdn.test/assets/app.3f9a2c1b.js?v=2')).toBe('/assets/app.js');
    expect(normalizeFilename('/assets/index-B7xQ2kLp.js')).toBe('/assets/index.js');
    expect(normalizeFilename('/js/app-facade.js')).toBe('/js/app-facade.js');
    expect(normalizeMessage('Profile 42 not found for "bob"')).toBe('Profile <n> not found for <str>');
  });
});

describe('error tracking over HTTP', { timeout: 20000 }, () => {
  it('new projects get caps, sampling and exception autocapture in remote config', async () => {
    const { p } = await owner();
    expect(p.limits).toMatchObject({ events_monthly: NEW_PROJECT_LIMITS.events_monthly, autocapture_sample_rate: 0.5, over_cap: 'drop' });
    expect(p.replay_config.sample_rate).toBe(0.25); expect(p.error_tracking).toBe(true);
    const c = await (await call(`/array/${p.api_token}/config`)).json() as any;
    expect(c.autocaptureExceptions).toBe(true); expect(c.errorTracking).toMatchObject({ autocaptureExceptions: true, suppressionRules: [] });
    const d = await (await call(`/flags/?v=2&config=true`, { method: 'POST', body: JSON.stringify({ token: p.api_token, distinct_id: 'x' }) })).json() as any;
    expect(d.autocaptureExceptions).toBe(true);
  });
  it('uploads a source map with a personal key, groups real exceptions into issues, tracks status and regressions', async () => {
    const { cookie, p } = await owner();
    const { key } = await (await call('/api/personal_api_keys', { method: 'POST', body: '{"label":"maps"}', cookie })).json() as any;
    const up = await call(`/api/projects/${p.id}/symbol_sets?url=${encodeURIComponent(MIN_URL + '?v=1')}`, { method: 'PUT', body: JSON.stringify(F.app_min_js_map), headers: { authorization: `Bearer ${key}` } });
    expect(up.status).toBe(201);
    expect(await up.json()).toMatchObject({ url: MIN_URL, replaced: false });
    expect((await call(`/api/projects/${p.id}/symbol_sets?url=x`, { method: 'PUT', body: '{"version":3,"sections":[]}', headers: { authorization: `Bearer ${key}` } })).status).toBe(400);
    expect((await call(`/api/projects/${p.id}/symbol_sets?url=x`, { method: 'PUT', body: '{}' })).status).toBe(401);
    // The four recorded browser exceptions plus one recorded posthog-node exception (v1 endpoint, gzip).
    for (const e of JS) expect((await capture(p.api_token, [{ ...e, uuid: crypto.randomUUID() }])).status).toBe(200);
    const node = { ...(F.posthog_node_exceptions as any[])[0], uuid: crypto.randomUUID() };
    const gz = new Uint8Array(await new Response(new Blob([JSON.stringify({ created_at: new Date().toISOString(), batch: [node] })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    expect((await call('/i/v1/analytics/events', { method: 'POST', body: gz, headers: { authorization: `Bearer ${p.api_token}`, 'content-encoding': 'gzip', 'content-type': 'application/json' } })).status).toBe(200);
    let list: any;
    await vi.waitFor(async () => { list = await (await call(`/api/projects/${p.id}/error_issues`, { cookie })).json(); expect(list.results.length).toBe(5); }, { timeout: 8000, interval: 200 });
    const price = list.results.find((i: any) => i.message === 'Price must be a number, got string');
    expect(price).toMatchObject({ type: 'TypeError', status: 'active', occurrences: 1, users: 1, top_frame: 'parsePrice (app-src.js:4)' });
    expect(list.results.find((i: any) => i.type === 'RangeError' && i.message === 'Negative amount for order 77')).toMatchObject({ top_frame: 'chargeCard (node-capture.mjs:5)' });
    const d = await (await call(`/api/projects/${p.id}/error_issues/${price.id}`, { cookie })).json() as any;
    expect(d.exception_list[0].stacktrace.frames.at(-1)).toMatchObject({ function: 'parsePrice', filename: 'app-src.js', lineno: 4, resolved: true });
    expect(d.occurrences_list[0]).toMatchObject({ handled: false, url: 'http://172.17.0.1:8797/' });
    // The stored event carries the issue id and the symbolicated frames.
    const evs = await (await call(`/api/projects/${p.id}/events?event=%24exception&limit=10`, { cookie })).json() as any;
    const stored = evs.results.find((e: any) => e.properties.$exception_issue_id === price.id);
    expect(stored.properties.$exception_list[0].stacktrace.type).toBe('resolved');
    // Status: resolve, then a new occurrence reopens it with a regression alert; suppressed issues stay quiet.
    expect((await (await call(`/api/projects/${p.id}/error_issues/${price.id}`, { method: 'PATCH', cookie, body: '{"status":"resolved"}' })).json() as any).status).toBe('resolved');
    expect((await call(`/api/projects/${p.id}/error_issues/${price.id}`, { method: 'PATCH', cookie, body: '{"status":"gone"}' })).status).toBe(400);
    await new Promise(r => setTimeout(r, 5));
    await capture(p.api_token, [{ ...JS[0], uuid: crypto.randomUUID(), timestamp: new Date(Date.now() + 1000).toISOString() }]);
    await vi.waitFor(async () => { const x = await (await call(`/api/projects/${p.id}/error_issues/${price.id}`, { cookie })).json() as any; expect(x).toMatchObject({ status: 'active', occurrences: 2, regressions: 1 }); }, { timeout: 8000, interval: 200 });
    const alerts = await (await call(`/api/projects/${p.id}/alerts`, { cookie })).json() as any;
    expect(alerts.results.filter((a: any) => a.kind === 'error_new').length).toBe(5);
    expect(alerts.results.find((a: any) => a.kind === 'error_regression').title).toMatch(/^Regression: TypeError/);
    expect(alerts.results[0].email_status).toBe('off');
    expect(alerts.unread).toBe(6);
    await call(`/api/projects/${p.id}/alerts/read`, { method: 'POST', cookie, body: '{}' });
    expect(((await (await call(`/api/projects/${p.id}/alerts`, { cookie })).json()) as any).unread).toBe(0);
    const sets = await (await call(`/api/projects/${p.id}/symbol_sets`, { cookie })).json() as any[];
    expect(sets[0]).toMatchObject({ ref: MIN_URL, path: '/app.min.js' }); expect(sets[0].last_used_at).toBeGreaterThan(0);
    expect((await call(`/api/projects/${p.id}/symbol_sets/${sets[0].id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect(((await (await call(`/api/projects/${p.id}/error_issues?status=resolved`, { cookie })).json()) as any).results.length).toBe(0);
  });
  it('emails alerts through the Email Sending binding when configured', async () => {
    const sent: any[] = [];
    const fake = { DB: E.DB, SITE_URL: SITE, ALERT_EMAIL_FROM: 'alerts@send.test', EMAIL: { send: async (m: any) => { if (m.to === 'bad@x.test') { const e: any = new Error('nope'); e.code = 'E_RECIPIENT_NOT_ALLOWED'; throw e; } sent.push(m); return { messageId: '1' }; } } } as any;
    const st = await emailAlert(fake, 'Shop', { kind: 'test', title: 'Test <alert>', body: 'Body', link: '/project/1/usage' }, ['a@x.test', 'bad@x.test']);
    expect(st).toBe('sent to 1, failed 1: E_RECIPIENT_NOT_ALLOWED');
    expect(sent[0]).toMatchObject({ from: 'alerts@send.test', to: 'a@x.test', subject: '[Shop] Test <alert>' });
    expect(sent[0].html).toContain('Test &lt;alert&gt;'); expect(sent[0].text).toContain('http://app.test/project/1/usage');
    expect(await emailAlert({ ...fake, EMAIL: undefined }, 'Shop', { kind: 'test', title: 't', body: 'b', link: null }, ['a@x.test'])).toBe('off');
  });
  it('a store with the binding emails its alerts (in-DO env)', async () => {
    const { cookie, p } = await owner();
    await patch(cookie, p.id, { limits: { alert_emails: ['ops@x.test'] } });
    const s = storeOf(p.id);
    await runInDurableObject(s as any, async (inst: any) => {
      (globalThis as any).__sent = [];
      inst.env = { ...inst.env, ALERT_EMAIL_FROM: 'alerts@send.test', EMAIL: { send: async (m: any) => { (globalThis as any).__sent.push(m); return { messageId: 'm' }; } } };
    });
    const r = await (await call(`/api/projects/${p.id}/alerts/test`, { method: 'POST', cookie, body: '{}' })).json() as any;
    expect(r.email_status).toBe('sent to 1');
    await runInDurableObject(s as any, async () => { expect((globalThis as any).__sent[0]).toMatchObject({ to: 'ops@x.test', subject: '[V05] Test alert' }); });
  });
});

describe('caps over HTTP', { timeout: 20000 }, () => {
  it('counts events exactly, alerts at 50/80/100%, writes cap state, then the edge answers quota_limited', async () => {
    const { cookie, p } = await owner();
    const q = await patch(cookie, p.id, { limits: { events_monthly: 10, autocapture_sample_rate: 1 } });
    expect(q.limits.events_monthly).toBe(10); expect(q.cap_state.events).toBe(false);
    const r1 = await capture(p.api_token, Array.from({ length: 6 }, (_, i) => ev('$pageview', 'u' + i)));
    expect(await r1.json()).toEqual({ status: 1 });
    await capture(p.api_token, Array.from({ length: 7 }, (_, i) => ev(i < 3 ? 'signup' : '$pageview', 'v' + i)));
    let u: any;
    await vi.waitFor(async () => { u = await (await call(`/api/projects/${p.id}/usage`, { cookie })).json(); expect(u.month_to_date.events + u.month_to_date.dropped_events).toBe(13); }, { timeout: 8000, interval: 200 });
    expect(u.month_to_date).toMatchObject({ events: 10, dropped_events: 3, requests: 2 });
    expect(u.caps.events).toMatchObject({ used: 10, cap: 10, pct: 100 });
    expect(u.daily.find((d: any) => d.event === 'signup').count).toBe(3);
    expect(u.cost.lines.length).toBeGreaterThan(5); expect(u.email.configured).toBe(false);
    const alerts = (await (await call(`/api/projects/${p.id}/alerts`, { cookie })).json() as any).results.filter((a: any) => a.kind === 'usage_threshold');
    expect(alerts.map((a: any) => a.title).sort()).toEqual(['50% of the monthly events cap used', '80% of the monthly events cap used', 'Monthly events cap reached']);
    const proj = await (await call(`/api/projects/${p.id}`, { cookie })).json() as any;
    expect(proj.cap_state.events).toBe(true);
    // The edge reads cap_state (PATCH and the store clear the token cache on this isolate within 30 s; force it here).
    await patch(cookie, p.id, { name: 'V05 capped' });
    const r2 = await capture(p.api_token, [ev('$pageview', 'w')]);
    expect(await r2.json()).toEqual({ status: 1, quota_limited: ['events', 'exceptionEvent'] });
    expect(((await (await call(`/array/${p.api_token}/config`)).json()) as any).autocaptureExceptions).toBe(false);
    // Raising the cap lifts the state at once.
    const up = await patch(cookie, p.id, { limits: { events_monthly: 1000 } });
    expect(up.cap_state.events).toBe(false);
    expect(await (await capture(p.api_token, [ev('$pageview', 'w')])).json()).toEqual({ status: 1 });
  });
  it('sample mode keeps a deterministic share of people past the cap', async () => {
    const { cookie, p } = await owner();
    await patch(cookie, p.id, { limits: { events_monthly: 0, over_cap: 'sample', over_cap_sample_rate: 0.5, autocapture_sample_rate: 1 } });
    const people = Array.from({ length: 40 }, (_, i) => 'p' + i);
    await capture(p.api_token, people.map(d => ev('$pageview', d)));
    const want = people.filter(d => sampled('cap:' + d, 0.5)).length;
    let u: any;
    // A cap of 0 is reached at once, so the edge already samples (same hash as the store); edge drops are not counted.
    await vi.waitFor(async () => { u = await (await call(`/api/projects/${p.id}/usage`, { cookie })).json() as any; expect(u.month_to_date.events).toBe(want); }, { timeout: 8000, interval: 200 });
    expect(want).toBeGreaterThan(10); expect(want).toBeLessThan(30); expect(u.month_to_date.dropped_events).toBe(0);
    await patch(cookie, p.id, { name: 'refresh' });
    const r = await capture(p.api_token, [ev('$pageview', 'p0')]);
    expect(await r.json()).toEqual({ status: 1 }); // sample mode never tells the SDK to stop
  });
  it('autocapture sampling drops a session-consistent share at the edge', async () => {
    const { cookie, p } = await owner();
    await patch(cookie, p.id, { limits: { autocapture_sample_rate: 0 } });
    await capture(p.api_token, [ev('$autocapture', 'a', { $session_id: 's1' }), ev('$pageview', 'a', { $session_id: 's1' })]);
    await vi.waitFor(async () => { const u = await (await call(`/api/projects/${p.id}/usage`, { cookie })).json() as any; expect(u.month_to_date.events).toBe(1); expect(u.daily.map((d: any) => d.event)).toEqual(['$pageview']); }, { timeout: 8000, interval: 200 });
  });
  it('replay caps refuse new sessions, delete their chunks and switch the recorder off', async () => {
    const { cookie, p } = await owner();
    await patch(cookie, p.id, { session_recording: true, limits: { replay_recordings_monthly: 1 } });
    const send = (sid: string) => call('/s/?compression=gzip-js', { method: 'POST', body: JSON.stringify((R.requests[0] as any[]).map(e => ({ ...e, properties: { ...e.properties, token: p.api_token, $session_id: sid } }))) });
    expect((await send('sess-a')).status).toBe(200);
    await vi.waitFor(async () => { const u = await (await call(`/api/projects/${p.id}/usage`, { cookie })).json() as any; expect(u.caps.recordings.used).toBe(1); expect(u.caps.replay_bytes.used).toBeGreaterThan(100); }, { timeout: 8000, interval: 200 });
    // Cap state is written; before the edge sees it, the store refuses the second session and its chunk is deleted.
    await send('sess-b');
    await vi.waitFor(async () => { const u = await (await call(`/api/projects/${p.id}/usage`, { cookie })).json() as any; expect(u.month_to_date.dropped_replay_chunks).toBe(1); }, { timeout: 8000, interval: 200 });
    await vi.waitFor(async () => { const l = await E.REPLAY.list({ prefix: `replay/${p.id}/sess-b/` }); expect(l.objects.length).toBe(0); }, { timeout: 8000, interval: 200 });
    expect((await call(`/api/projects/${p.id}/session_recordings/sess-b`, { cookie })).status).toBe(404);
    await patch(cookie, p.id, { name: 'refresh' });
    expect(await (await send('sess-c')).json()).toEqual({ status: 1, quota_limited: ['recordings'] });
    expect(((await (await call(`/array/${p.api_token}/config`)).json()) as any).sessionRecording).toBe(false);
  });
  it('flags a daily spike against the 7-day average (cron)', async () => {
    const { p } = await owner();
    const s = storeOf(p.id);
    const day = 86400_000; const now = Date.now();
    const mk = (n: number, at: number) => Array.from({ length: n }, (_, i) => ({ uuid: crypto.randomUUID(), event: i % 2 ? '$autocapture' : '$pageview', distinct_id: 'd' + i, ts: at, properties: {}, person: false, received_at: at }));
    for (let d = 2; d <= 8; d++) await s.ingest(mk(20, now - d * day) as any, p.id);
    await s.ingest(mk(200, now - day) as any, p.id);
    const a: any = await s.checkSpike(p.id, now);
    expect(a).toMatchObject({ email_status: 'off' });
    expect(await s.checkSpike(p.id, now)).toBeNull(); // once per day
    const list: any = await s.listAlerts();
    expect(list.results[0].title).toMatch(/^Event spike on .*: 200 events \(10\.0x the 7-day average\)/);
  });
});
