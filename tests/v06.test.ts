// 0.6: HTML fallback, PUBLIC_DEMO read-only mode, edge usage counters, error tracking (releases, versioned and sectioned
// source maps, retroactive symbolication, merge/split, grouping and suppression rules, assignment, non-JS stacks),
// LLM analytics (AI capture endpoints, pricing, overview/traces/trace) and cold Trends (design.md 0.6 sections).
import { describe, it, expect, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import F from './fixtures/v05-errors.json';
import worker from '../src/worker/index';
import { wantsApp } from '../src/worker/routing';
import { PROJECT_CACHE_TTL_MS } from '../src/worker/projects';
import { estimateCost } from '../src/worker/usage';
import { decodeMap, originalPosition, validateMap } from '../src/shared/sourcemap';
import { releaseOf, cleanGroupingRule, cleanSuppressionRule, suppressed, fingerprintOf, exceptionList, unresolvedFrames, symbolicate, topFrame, RuleError } from '../src/worker/errors';
import { priceOf, costOf, normalizeModel } from '../src/shared/llm-pricing';
import { buildColdTrends, coldTrendsResults, runColdTrends, COLD_TRENDS_MAX_BUCKETS } from '../src/worker/cold';
import type { ProjectStore } from '../src/worker/store';

const SITE = 'http://app.test';
const E = env as any;
const W = (exports as any).default;
const call = (path: string, init: RequestInit & { cookie?: string } = {}, e?: any) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set('cookie', init.cookie);
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && !h.has('origin') && path.startsWith('/api/') && !h.has('authorization')) h.set('origin', SITE);
  const req = new Request(SITE + path, { ...init, headers: h });
  if (!e) return W.fetch(req) as Promise<Response>;
  const ctx = createExecutionContext();
  return (async () => { const r = await worker.fetch(req as any, e, ctx); await waitOnExecutionContext(ctx); return r; })();
};
async function owner(name = 'V06') {
  const body = JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' });
  let r = await call('/api/signup', { method: 'POST', body });
  if (r.status !== 201) r = await call('/api/login', { method: 'POST', body });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const p = await (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name, timezone: 'UTC' }), cookie })).json() as any;
  return { cookie, p };
}
const j = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;
const patch = async (cookie: string, pid: number, body: unknown) => { const r = await call(`/api/projects/${pid}`, { method: 'PATCH', cookie, body: JSON.stringify(body) }); expect(r.status).toBe(200); return r.json() as any; };
const capture = (token: string, batch: any[], path = '/i/v0/e/') => call(path, { method: 'POST', body: JSON.stringify(batch.map(e => ({ ...e, properties: { ...e.properties, token } }))) });
const storeOf = (pid: number) => E.STORE.get(E.STORE.idFromName(`project:${pid}`)) as unknown as ProjectStore;
const JS = F.posthog_js_exceptions as any[];
const MIN_URL = 'http://172.17.0.1:8797/app.min.js';
const exc = (did: string, list: any[], extra: Record<string, unknown> = {}) => ({ event: '$exception', distinct_id: did, uuid: crypto.randomUUID(), properties: { $exception_list: list, ...extra } });

// Real-shaped server SDK exception lists (posthog-python 6.x, posthog-go, posthog-rs): frames come pre-symbolicated.
const PY = [{ type: 'ValueError', value: 'quantity must be positive, got -3', mechanism: { type: 'generic', handled: true, synthetic: false }, module: null, thread_id: null,
  stacktrace: { type: 'raw', frames: [
    { platform: 'python', filename: 'app/server.py', abs_path: '/srv/app/server.py', function: 'handle', module: 'app.server', lineno: 88, colno: null, in_app: true, pre_context: ['def handle(req):'], context_line: '    return checkout(req.json())', post_context: [] },
    { platform: 'python', filename: 'app/cart.py', abs_path: '/srv/app/cart.py', function: 'checkout', module: 'app.cart', lineno: 42, colno: null, in_app: true, pre_context: ['def checkout(cart):', '    qty = cart["qty"]'], context_line: '    raise ValueError(f"quantity must be positive, got {qty}")', post_context: [] }] } }];
const GO = [{ type: '*errors.errorString', value: 'payment declined: card_expired', mechanism: { type: 'generic', handled: true },
  stacktrace: { type: 'raw', frames: [
    { platform: 'go', filename: 'main.go', abs_path: '/app/main.go', function: 'main.main', module: 'main', lineno: 31, in_app: true },
    { platform: 'go', filename: 'billing/charge.go', abs_path: '/app/billing/charge.go', function: 'billing.Charge', module: 'example.com/app/billing', lineno: 57, in_app: true }] } }];
const RS = [{ type: 'std::io::Error', value: 'connection refused (os error 111)', mechanism: { type: 'generic', handled: true },
  stacktrace: { type: 'raw', frames: [
    { platform: 'rust', filename: 'src/main.rs', function: 'app::main', lineno: 12, in_app: true },
    { platform: 'rust', filename: 'src/net.rs', function: 'app::net::connect', lineno: 40, colno: 9, in_app: true }] } }];

describe('HTML fallback for app routes', () => {
  it('decides by method, path and Accept', () => {
    expect(wantsApp('GET', '/project/1/insights', 'text/html,*/*')).toBe(true);
    expect(wantsApp('GET', '/project/1/llm', '')).toBe(true);
    expect(wantsApp('HEAD', '/anything/deep', '*/*')).toBe(true);
    expect(wantsApp('GET', '/project/1', 'application/json')).toBe(false);
    expect(wantsApp('GET', '/project/1', 'application/json, text/html')).toBe(true);
    expect(wantsApp('POST', '/project/1', 'text/html')).toBe(false);
    for (const p of ['/api/nope', '/static/x', '/i/v0/e', '/flags', '/decide', '/array/x/config', '/e', '/batch', '/_health']) expect(wantsApp('GET', p, 'text/html')).toBe(false);
    expect(wantsApp('GET', '/favicon.ico', 'text/html')).toBe(false);
  });
  it('serves ui.html for unknown app paths and JSON 404 for API paths', async () => {
    const r = await call('/project/9/llm/traces/abc', { headers: { accept: 'text/html' } });
    expect(r.status).toBe(200); expect(r.headers.get('content-type')).toMatch(/text\/html/); expect(await r.text()).toContain('<html');
    // Unknown API paths never fall back to HTML (signed out they answer 401 JSON, signed in 404 JSON).
    const a = await call('/api/does-not-exist', { headers: { accept: 'text/html' } });
    expect(a.status).toBe(401); expect(a.headers.get('content-type')).toMatch(/json/);
    const { cookie } = await owner();
    const b = await call('/api/does-not-exist', { headers: { accept: 'text/html' }, cookie });
    expect(b.status).toBe(404); expect(b.headers.get('content-type')).toMatch(/json/);
    expect((await call('/whatever', { headers: { accept: 'application/json' } })).status).toBe(404);
    expect((await call('/missing.js')).status).toBe(404);
  });
});

describe('public demo (PUBLIC_DEMO=1)', { timeout: 20000 }, () => {
  it('is off by default: signed-out API calls get 401', async () => {
    expect((await call('/api/me')).status).toBe(401);
    expect((await j(call('/api/config'))).public_demo).toBe(false);
  });
  it('signed-out visitors read demo projects only, writes get 403 demo_read_only, owner data is redacted', async () => {
    const DEMO = { ...E, PUBLIC_DEMO: '1' };
    const { cookie, p } = await owner('Demo');
    const priv = (await owner('Private')).p;
    expect((await j(call('/api/config', {}, DEMO))).public_demo).toBe(true);
    const q = await patch(cookie, p.id, { public_demo: true, limits: { alert_emails: ['ops@secret.test'] } });
    expect(q.public_demo).toBe(true);
    await call('/api/personal_api_keys', { method: 'POST', body: '{"label":"k"}', cookie });
    await call(`/api/projects/${p.id}/insights`, { method: 'POST', cookie, body: JSON.stringify({ name: 'By owner@example.com', query: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview' }] } }) });
    expect(await j(call('/api/me', {}, DEMO))).toMatchObject({ demo: true, email: null });
    const ps = await j(call('/api/projects', {}, DEMO));
    expect(ps.map((x: any) => x.id)).toEqual([p.id]);
    expect(ps[0].api_token).toBe('phc_demo_token_hidden'); expect(ps[0].limits.alert_emails).toEqual([]);
    expect(JSON.stringify(ps)).not.toContain(p.api_token); expect(JSON.stringify(ps)).not.toContain('ops@secret.test');
    expect(await j(call('/api/personal_api_keys', {}, DEMO))).toEqual([]);
    expect((await j(call('/api/users', {}, DEMO))).every((u: any) => u.email === null)).toBe(true);
    const ins = await j(call(`/api/projects/${p.id}/insights`, {}, DEMO));
    expect(JSON.stringify(ins)).not.toContain('owner@example.com');
    // Reads and read-only POSTs work.
    expect((await call(`/api/projects/${p.id}/query`, { method: 'POST', body: JSON.stringify({ query: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview' }] } }) }, DEMO)).status).toBe(200);
    expect((await call(`/api/projects/${p.id}/sql`, { method: 'POST', body: JSON.stringify({ query: 'SELECT count() FROM events' }) }, DEMO)).status).toBe(200);
    expect((await call(`/api/projects/${p.id}/llm/overview`, {}, DEMO)).status).toBe(200);
    expect((await call(`/api/projects/${p.id}/usage`, {}, DEMO)).status).toBe(200);
    // Every mutation is refused.
    for (const [m, path, body] of [['POST', `/api/projects/${p.id}/insights`, '{}'], ['PATCH', `/api/projects/${p.id}`, '{"name":"x"}'], ['DELETE', `/api/projects/${p.id}`, ''], ['POST', '/api/projects', '{"name":"x"}'],
      ['POST', `/api/projects/${p.id}/feature_flags`, '{}'], ['POST', `/api/projects/${p.id}/reset_token`, '{}'], ['POST', `/api/projects/${p.id}/alerts/test`, '{}'], ['POST', '/api/personal_api_keys', '{}'],
      ['POST', `/api/projects/${p.id}/error_grouping_rules`, '{}'], ['PUT', `/api/projects/${p.id}/symbol_sets?url=x`, '{}']] as const) {
      const r = await call(path, { method: m, body: body || undefined }, DEMO);
      expect([m, path, r.status]).toEqual([m, path, 403]); expect((await r.json() as any).error).toBe('demo_read_only');
    }
    expect((await call(`/api/projects/${p.id}/feature_flags/local_evaluation`, {}, DEMO)).status).toBe(403);
    // Projects not marked public stay private.
    expect((await call(`/api/projects/${priv.id}/events`, {}, DEMO)).status).toBe(404);
    // ALLOWED_EMAILS still applies to signup and login.
    const r = await call('/api/signup', { method: 'POST', body: JSON.stringify({ email: 'stranger@evil.test', password: 'correct horse battery' }) }, { ...DEMO, ALLOWED_EMAILS: 'owner@example.com' });
    expect(r.status).toBe(403);
    // The owner, signed in, still has full access on a demo instance.
    expect((await j(call('/api/me', { cookie }, DEMO))).email).toBe('owner@example.com');
  });
});

describe('usage counters and cost', { timeout: 20000 }, () => {
  it('project cache TTL is 10 s', () => { expect(PROJECT_CACHE_TTL_MS).toBe(10_000); });
  it('counts flags, config and API requests and edge drops; cost includes them', async () => {
    const { cookie, p } = await owner();
    expect((await call('/flags/?v=2', { method: 'POST', body: JSON.stringify({ token: p.api_token, distinct_id: 'u' }) })).status).toBe(200);
    await vi.waitFor(async () => { const u = await j(call(`/api/projects/${p.id}/usage`, { cookie })); expect(u.month_to_date.flag_requests).toBeGreaterThanOrEqual(1); }, { timeout: 8000, interval: 200 });
    const day = new Date().toISOString().slice(0, 10);
    await storeOf(p.id).recordEdgeUsage(day, { config: 5, api: 7, edge_dropped_events: 11, edge_dropped_requests: 3, edge_dropped_replay: 2 });
    const u = await j(call(`/api/projects/${p.id}/usage`, { cookie }));
    expect(u.month_to_date).toMatchObject({ config_requests: 5, edge_dropped_events: 11, edge_dropped_requests: 3, edge_dropped_replay: 2 });
    expect(u.month_to_date.api_requests).toBeGreaterThanOrEqual(7);
    expect(u.dropped_past_cap).toEqual({ events: 11, requests: 3, replay_uploads: 2 });
    expect(u.cost.notes.join(' ')).toMatch(/only workload/);
  });
  it('estimateCost counts every Worker request kind', () => {
    const base = { events: 1e6, event_bytes: 1e9, requests: 1e5, recordings: 0, replay_bytes: 0, replay_chunks: 0, emails: 0, stored_db_bytes: 0, stored_r2_bytes: 0, cold_tier: false } as any;
    const a = estimateCost(base); const b = estimateCost({ ...base, flag_requests: 2e7, config_requests: 1e7, api_requests: 1e6, edge_dropped_requests: 5e6 });
    const req = (c: any) => c.lines.find((l: any) => /Workers requests/i.test(l.label));
    expect(req(b).quantity - req(a).quantity).toBe(3.6e7);
    expect(b.list_usd).toBeGreaterThan(a.list_usd);
  });
  it('quota-limited capture is counted as dropped at the edge', async () => {
    const { cookie, p } = await owner();
    await patch(cookie, p.id, { limits: { events_monthly: 1, autocapture_sample_rate: 1 } });
    await capture(p.api_token, [{ event: 'a', distinct_id: 'x', uuid: crypto.randomUUID(), properties: {} }, { event: 'b', distinct_id: 'x', uuid: crypto.randomUUID(), properties: {} }]);
    await vi.waitFor(async () => { const u = await j(call(`/api/projects/${p.id}/usage`, { cookie })); expect(u.caps.events.used).toBe(1); }, { timeout: 8000, interval: 200 });
    // The store refused the event past the cap; once the 10 s project cache sees cap_state, the edge drops (and meters) instead.
    const u = await j(call(`/api/projects/${p.id}/usage`, { cookie }));
    expect(u.dropped_past_cap.events).toBeGreaterThanOrEqual(1);
  });
});

describe('sectioned source maps', () => {
  const inner = F.app_min_js_map as any;
  it('decodes sections with line and column offsets', () => {
    const plain = decodeMap(inner);
    const m = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: inner }, { offset: { line: 100, column: 10 }, map: inner }] };
    expect(validateMap(m)).toBeNull();
    const d = decodeMap(m as any);
    const p0 = originalPosition(plain, 1, 50);
    expect(originalPosition(d, 1, 50)).toMatchObject({ source: p0!.source, line: p0!.line, name: p0!.name });
    // Line 101, column 60 is line 1, column 50 of the second section (first line shifted by the column offset).
    expect(originalPosition(d, 101, 60)).toMatchObject({ source: p0!.source, line: p0!.line });
  });
  it('rejects url sections, nesting, overlap and empty sections', () => {
    expect(validateMap({ version: 3, sections: [{ offset: { line: 0, column: 0 }, url: 'x.map' }] })).toMatch(/url/);
    expect(validateMap({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sections: [] } }] })).toBeTruthy();
    expect(validateMap({ version: 3, sections: [{ offset: { line: 5, column: 0 }, map: inner }, { offset: { line: 1, column: 0 }, map: inner }] })).toBeTruthy();
    expect(validateMap({ version: 3, sections: [] })).toMatch(/sections/);
  });
});

describe('error tracking 0.6 units', () => {
  it('reads the release from $release, release, $app_version, app_version', () => {
    expect(releaseOf({ $release: '2.1.0', $app_version: '9' })).toBe('2.1.0');
    expect(releaseOf({ release: 'abc123' })).toBe('abc123');
    expect(releaseOf({ $app_version: 7 })).toBe('7');
    expect(releaseOf({ app_version: ' 1.0 ' })).toBe('1.0');
    expect(releaseOf({})).toBeNull();
  });
  it('grouping rules run after $exception_fingerprint and before default grouping', async () => {
    const rule = cleanGroupingRule({ field: 'value', match: 'contains', pattern: 'payment declined', key: 'payments' });
    expect(await fingerprintOf({}, GO, [rule])).toBe('rule:payments');
    expect(await fingerprintOf({ $exception_fingerprint: 'mine' }, GO, [rule])).toBe('custom:mine');
    expect(await fingerprintOf({}, PY, [rule])).toMatch(/^[0-9a-f]{32}$/);
    expect(await fingerprintOf({}, RS, [cleanGroupingRule({ field: 'function', match: 'regex', pattern: '^app::net::', key: 'net' })])).toBe('rule:net');
    expect(await fingerprintOf({}, PY, [cleanGroupingRule({ field: 'filename', match: 'exact', pattern: 'app/cart.py', key: 'cart' })])).toBe('rule:cart');
    expect(() => cleanGroupingRule({ field: 'type', match: 'regex', pattern: '(', key: 'k' })).toThrow(RuleError);
    expect(() => cleanGroupingRule({ field: 'nope', match: 'exact', pattern: 'x', key: 'k' })).toThrow(RuleError);
  });
  it('suppression rules use the posthog-js wire shape and operators', () => {
    const r = cleanSuppressionRule({ type: 'OR', values: [{ key: '$exception_types', operator: 'exact', value: ['ResizeObserver loop limit exceeded', 'AbortError'] }] });
    expect(r).toEqual({ type: 'OR', values: [{ key: '$exception_types', operator: 'exact', value: ['ResizeObserver loop limit exceeded', 'AbortError'], type: 'error_tracking_issue_property' }] });
    expect(suppressed([r], [{ type: 'AbortError', value: 'x' }])).toBe(true);
    expect(suppressed([r], [{ type: 'TypeError', value: 'x' }])).toBe(false);
    const and = cleanSuppressionRule({ type: 'AND', values: [{ key: '$exception_types', operator: 'exact', value: 'TypeError' }, { key: '$exception_values', operator: 'icontains', value: 'chrome-extension' }] });
    expect(suppressed([and], [{ type: 'TypeError', value: 'from chrome-extension://abc' }])).toBe(true);
    expect(suppressed([and], [{ type: 'TypeError', value: 'other' }])).toBe(false);
    expect(suppressed([cleanSuppressionRule({ type: 'OR', values: [{ key: '$exception_values', operator: 'regex', value: '^Script error' }] })], [{ type: 'Error', value: 'Script error.' }])).toBe(true);
    expect(suppressed([cleanSuppressionRule({ type: 'OR', values: [{ key: '$exception_types', operator: 'not_icontains', value: 'error' }] })], [{ type: 'Panic', value: '' }])).toBe(true);
    expect(() => cleanSuppressionRule({ type: 'OR', values: [{ key: '$exception_types', operator: 'gt', value: '1' }] })).toThrow();
    expect(() => cleanSuppressionRule({ type: 'XOR', values: [] })).toThrow();
  });
  it('Python, Go and Rust stacks are pre-symbolicated: never sent to the JS source map path', async () => {
    for (const l of [PY, GO, RS]) {
      expect(exceptionList({ $exception_list: l }).length).toBe(1);
      expect(unresolvedFrames(l as any)).toBe(false);
      const r = await symbolicate(l as any, async () => { throw new Error('should not load a map'); });
      expect(r.resolved).toBe(0);
    }
    expect(topFrame(PY as any)).toBe('checkout (app/cart.py:42)');
    expect(topFrame(GO as any)).toBe('billing.Charge (billing/charge.go:57)');
    expect(topFrame(RS as any)).toBe('app::net::connect (src/net.rs:40)');
    expect(await fingerprintOf({}, PY as any)).toBe(await fingerprintOf({}, structuredClone(PY) as any));
  });
});

describe('error tracking 0.6 over HTTP', { timeout: 30000 }, () => {
  it('releases, versioned maps and retroactive symbolication', async () => {
    const { cookie, p } = await owner();
    const { key } = await j(call('/api/personal_api_keys', { method: 'POST', body: '{"label":"maps"}', cookie }));
    // The exception arrives before its map.
    await capture(p.api_token, [{ ...JS[0], uuid: crypto.randomUUID(), properties: { ...JS[0].properties, $app_version: '1.0.0' } }]);
    let issue: any;
    await vi.waitFor(async () => { const l = await j(call(`/api/projects/${p.id}/error_issues`, { cookie })); expect(l.results.length).toBe(1); issue = l.results[0]; }, { timeout: 8000, interval: 200 });
    expect(issue.top_frame).not.toMatch(/app-src\.js/);
    expect(issue).toMatchObject({ first_seen_release: '1.0.0', last_seen_release: '1.0.0' });
    // A map for another release does not apply; the right release (or none) does, retroactively.
    let up = await j(call(`/api/projects/${p.id}/symbol_sets?url=${encodeURIComponent(MIN_URL)}&release=2.0.0`, { method: 'PUT', body: JSON.stringify(F.app_min_js_map), headers: { authorization: `Bearer ${key}` } }));
    expect(up).toMatchObject({ release: '2.0.0', resymbolicated: { symbolicated: 0 } });
    up = await j(call(`/api/projects/${p.id}/symbol_sets?url=${encodeURIComponent(MIN_URL)}&release=1.0.0`, { method: 'PUT', body: JSON.stringify(F.app_min_js_map), headers: { authorization: `Bearer ${key}` } }));
    expect(up).toMatchObject({ release: '1.0.0', resymbolicated: { scanned: 1, symbolicated: 1, issues: 1 } });
    const d = await j(call(`/api/projects/${p.id}/error_issues/${issue.id}`, { cookie }));
    expect(d.top_frame).toBe('parsePrice (app-src.js:4)');
    expect(d.occurrences_list[0]).toMatchObject({ release: '1.0.0', symbolicated: true });
    expect(d.releases[0]).toMatchObject({ release: '1.0.0', occurrences: 1 });
    const sets = await j(call(`/api/projects/${p.id}/symbol_sets`, { cookie }));
    expect(sets.map((s: any) => s.release).sort()).toEqual(['1.0.0', '2.0.0']);
    // A later, already-symbolicated occurrence groups into the same issue (alias of the resolved fingerprint).
    await capture(p.api_token, [{ ...JS[0], uuid: crypto.randomUUID(), properties: { ...JS[0].properties, $app_version: '1.0.0' } }]);
    await vi.waitFor(async () => { const x = await j(call(`/api/projects/${p.id}/error_issues/${issue.id}`, { cookie })); expect(x.occurrences).toBe(2); }, { timeout: 8000, interval: 200 });
    expect((await j(call(`/api/projects/${p.id}/error_issues?status=`, { cookie }))).results.length).toBe(1);
    // Release filter and release list.
    expect((await j(call(`/api/projects/${p.id}/error_issues?release=1.0.0`, { cookie }))).results.length).toBe(1);
    expect((await j(call(`/api/projects/${p.id}/error_issues?release=9.9.9`, { cookie }))).results.length).toBe(0);
    expect((await j(call(`/api/projects/${p.id}/error_issues/releases`, { cookie })))[0]).toMatchObject({ release: '1.0.0', occurrences: 2, issues: 1 });
  });
  it('merge, split and assignment', async () => {
    const { cookie, p } = await owner();
    expect((await capture(p.api_token, [exc('py-1', PY, { $lib: 'posthog-python' }), exc('go-1', GO, { $lib: 'posthog-go' }), exc('rs-1', RS, { $lib: 'posthog-rs' })])).status).toBe(200);
    let l: any;
    await vi.waitFor(async () => { l = await j(call(`/api/projects/${p.id}/error_issues`, { cookie })); expect(l.results.length).toBe(3); }, { timeout: 8000, interval: 200 });
    const py = l.results.find((i: any) => i.type === 'ValueError'); const go = l.results.find((i: any) => i.type === '*errors.errorString'); const rs = l.results.find((i: any) => i.type === 'std::io::Error');
    expect(py.top_frame).toBe('checkout (app/cart.py:42)'); expect(go.top_frame).toBe('billing.Charge (billing/charge.go:57)'); expect(rs.top_frame).toBe('app::net::connect (src/net.rs:40)');
    const pd = await j(call(`/api/projects/${p.id}/error_issues/${py.id}`, { cookie }));
    expect(pd.exception_list[0].stacktrace.frames[1]).toMatchObject({ platform: 'python', context_line: expect.stringContaining('raise ValueError') });
    // Merge Go and Rust into Python.
    const m = await call(`/api/projects/${p.id}/error_issues/${py.id}/merge`, { method: 'POST', cookie, body: JSON.stringify({ ids: [go.id, rs.id] }) });
    expect(m.status).toBe(200); expect(await m.json()).toMatchObject({ id: py.id, occurrences: 3, users: 3 });
    expect((await j(call(`/api/projects/${p.id}/error_issues?status=`, { cookie }))).results.map((i: any) => i.id)).toEqual([py.id]);
    expect((await call(`/api/projects/${p.id}/error_issues/${py.id}/merge`, { method: 'POST', cookie, body: JSON.stringify({ ids: [py.id] }) })).status).toBe(400);
    const merged = await j(call(`/api/projects/${p.id}/error_issues/${py.id}`, { cookie }));
    expect(merged.fingerprints.length).toBe(3); expect(merged.merged_issues.length).toBe(2);
    // New Go occurrences follow the merge.
    await capture(p.api_token, [exc('go-2', GO)]);
    await vi.waitFor(async () => { expect((await j(call(`/api/projects/${p.id}/error_issues/${py.id}`, { cookie }))).occurrences).toBe(4); }, { timeout: 8000, interval: 200 });
    // Split Go back out.
    const goFp = merged.fingerprints.find((f: any) => !f.primary && merged.occurrences_list.some((o: any) => o.fingerprint === f.fingerprint && o.distinct_id.startsWith('go-'))).fingerprint;
    const sp = await call(`/api/projects/${p.id}/error_issues/${py.id}/split`, { method: 'POST', cookie, body: JSON.stringify({ fingerprint: goFp }) });
    expect(sp.status).toBe(201); const spl = await sp.json() as any;
    expect(spl.split).toMatchObject({ occurrences: 2, type: '*errors.errorString' }); expect(spl.issue.occurrences).toBe(2);
    expect((await call(`/api/projects/${p.id}/error_issues/${py.id}/split`, { method: 'POST', cookie, body: JSON.stringify({ fingerprint: 'nope' }) })).status).toBe(400);
    // Assignment by email, filter, unassign.
    const me = await j(call('/api/me', { cookie }));
    const a = await j(call(`/api/projects/${p.id}/error_issues/${py.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ assignee: 'OWNER@example.com' }) }));
    expect(a.assignee).toEqual({ id: me.id, email: 'owner@example.com' });
    expect((await call(`/api/projects/${p.id}/error_issues/${py.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ assignee: 'nobody@x.test' }) })).status).toBe(400);
    expect((await j(call(`/api/projects/${p.id}/error_issues?assignee=me`, { cookie }))).results.map((i: any) => i.id)).toEqual([py.id]);
    expect((await j(call(`/api/projects/${p.id}/error_issues?assignee=none`, { cookie }))).results.map((i: any) => i.id)).not.toContain(py.id);
    expect((await j(call(`/api/projects/${p.id}/error_issues/${py.id}`, { method: 'PATCH', cookie, body: '{"assignee":null}' }))).assignee).toBeNull();
  });
  it('grouping rules group new exceptions; suppression rules reach posthog-js config and drop at ingest', async () => {
    const { cookie, p } = await owner();
    const g = await call(`/api/projects/${p.id}/error_grouping_rules`, { method: 'POST', cookie, body: JSON.stringify({ field: 'value', match: 'contains', pattern: 'declined', key: 'payments', description: 'All declines' }) });
    expect(g.status).toBe(201); const rule = await g.json() as any;
    expect((await call(`/api/projects/${p.id}/error_grouping_rules`, { method: 'POST', cookie, body: JSON.stringify({ field: 'value', match: 'regex', pattern: '(', key: 'k' }) })).status).toBe(400);
    const s = await call(`/api/projects/${p.id}/error_suppression_rules`, { method: 'POST', cookie, body: JSON.stringify({ type: 'OR', values: [{ key: '$exception_types', operator: 'exact', value: ['std::io::Error'] }] }) });
    expect(s.status).toBe(201);
    const c = await j(call(`/array/${p.api_token}/config`));
    expect(c.errorTracking.suppressionRules).toEqual([{ type: 'OR', values: [{ key: '$exception_types', operator: 'exact', value: ['std::io::Error'], type: 'error_tracking_issue_property' }] }]);
    const GO2 = structuredClone(GO); GO2[0].value = 'payment declined: insufficient_funds'; GO2[0].stacktrace.frames[1].lineno = 99;
    await capture(p.api_token, [exc('a', GO), exc('b', GO2), exc('c', RS), exc('d', PY)]);
    let l: any;
    await vi.waitFor(async () => { l = await j(call(`/api/projects/${p.id}/error_issues`, { cookie })); expect(l.results.length).toBe(2); }, { timeout: 8000, interval: 200 });
    expect(l.results.find((i: any) => i.fingerprint === 'rule:payments')).toMatchObject({ occurrences: 2 });
    const u = await j(call(`/api/projects/${p.id}/usage`, { cookie }));
    expect(u.month_to_date.suppressed_exceptions).toBe(1);
    expect((await call(`/api/projects/${p.id}/error_grouping_rules/${rule.id}`, { method: 'PATCH', cookie, body: '{"enabled":false}' })).status).toBe(200);
    expect((await j(call(`/api/projects/${p.id}/error_grouping_rules`, { cookie })))[0].enabled).toBe(false);
    expect((await call(`/api/projects/${p.id}/error_grouping_rules/${rule.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await call(`/api/projects/${p.id}/error_grouping_rules/${rule.id}`, { method: 'DELETE', cookie })).status).toBe(404);
  });
  it('symbol sets are unique per (release, url)', async () => {
    const { p } = await owner();
    await runInDurableObject(storeOf(p.id) as any, async (inst: any) => {
      const cols = inst.sql.exec(`SELECT name FROM pragma_table_info('symbol_sets')`).toArray().map((r: any) => r.name);
      expect(cols).toContain('release');
      await inst.addSymbolSet('https://x.test/a.js', 'k1', 1, '');
      await inst.addSymbolSet('https://x.test/a.js', 'k2', 1, '1.0');
      expect((await inst.addSymbolSet('https://x.test/a.js', 'k3', 1, '1.0')).replaced).toBe('k2');
      expect(inst.sql.exec('SELECT COUNT(*) AS n FROM symbol_sets').one().n).toBe(2);
    });
  });
});

const gen = (trace: string, o: Record<string, unknown> = {}) => ({ event: '$ai_generation', distinct_id: 'llm-user', uuid: crypto.randomUUID(), properties: {
  $ai_trace_id: trace, $ai_span_id: crypto.randomUUID(), $ai_model: 'gpt-4o-mini', $ai_provider: 'openai', $ai_input_tokens: 1000, $ai_output_tokens: 200, $ai_latency: 0.8, $ai_http_status: 200,
  $ai_input: [{ role: 'user', content: 'Hi' }], $ai_output_choices: [{ role: 'assistant', content: 'Hello!' }], ...o } });

describe('LLM analytics', { timeout: 30000 }, () => {
  it('prices models from the built-in table; SDK cost wins', () => {
    expect(priceOf('gpt-4o-mini-2024-07-18')!.key).toBe('gpt-4o-mini');
    expect(priceOf('openai/gpt-4o')!.key).toBe('gpt-4o');
    expect(priceOf('claude-3-5-sonnet-20241022')!.key).toMatch(/^claude-3-5-sonnet/);
    expect(priceOf('totally-unknown-model')).toBeNull();
    expect(normalizeModel('OpenAI/GPT-4o')).toBe('gpt-4o');
    expect(costOf({ $ai_total_cost_usd: 0.5, $ai_model: 'gpt-4o' })).toEqual({ usd: 0.5, source: 'sdk' });
    const p = priceOf('gpt-4o-mini')!.price;
    expect(costOf({ $ai_model: 'gpt-4o-mini', $ai_input_tokens: 1e6, $ai_output_tokens: 1e6 }).usd).toBeCloseTo(p.input + p.output, 6);
    // OpenAI includes cached tokens in input; Anthropic reports them apart.
    expect(costOf({ $ai_model: 'gpt-4o-mini', $ai_input_tokens: 1e6, $ai_cache_read_input_tokens: 1e6 }).usd).toBeCloseTo(p.cached, 6);
    const c = priceOf('claude-3-5-haiku')!.price;
    expect(costOf({ $ai_model: 'claude-3-5-haiku', $ai_provider: 'anthropic', $ai_input_tokens: 1e6, $ai_cache_read_input_tokens: 1e6 }).usd).toBeCloseTo(c.input + c.cached, 6);
    expect(costOf({ $ai_model: 'nope', $ai_input_tokens: 5 })).toEqual({ usd: null, source: null });
    // Missing SDK costs (null from a JSON extract) fall back to list prices.
    expect(costOf({ $ai_model: 'gpt-4o-mini', $ai_input_tokens: 1e6, $ai_total_cost_usd: null, $ai_input_cost_usd: null, $ai_output_cost_usd: null }).source).toBe('pricing');
  });
  it('ingests /i/v0/ai/batch, /i/v0/ai multipart, /i/v1/ai/events and normal capture; rejects misrouted events', async () => {
    const { cookie, p } = await owner();
    const t1 = 'trace-' + crypto.randomUUID();
    const root = { event: '$ai_trace', distinct_id: 'llm-user', uuid: crypto.randomUUID(), properties: { $ai_trace_id: t1, $ai_span_name: 'support-bot', $ai_latency: 2.5, $ai_input_state: { q: 'refund?' }, $ai_output_state: { a: 'ok' } } };
    const span = crypto.randomUUID();
    const sp = { event: '$ai_span', distinct_id: 'llm-user', uuid: crypto.randomUUID(), properties: { $ai_trace_id: t1, $ai_span_id: span, $ai_parent_id: t1, $ai_span_name: 'retrieve', $ai_latency: 0.3 } };
    // Legacy-shaped AI batch: the $pageview is dropped (misrouted), AI events kept.
    expect((await capture(p.api_token, [root, sp, { event: '$pageview', distinct_id: 'x', properties: {} }], '/i/v0/ai/batch/')).status).toBe(200);
    // Multipart: event part + event.properties part (posthog AI SDK large-payload path).
    const fd = new FormData();
    const g1 = gen(t1, { $ai_parent_id: span, $ai_span_name: 'answer' });
    fd.append('event', new Blob([JSON.stringify({ event: g1.event, distinct_id: g1.distinct_id, uuid: g1.uuid, timestamp: new Date().toISOString(), properties: { $ai_trace_id: t1 } })], { type: 'application/json' }), 'event');
    fd.append('event.properties', new Blob([JSON.stringify(g1.properties)], { type: 'application/json' }), 'event.properties');
    const mp = await W.fetch(new Request(SITE + '/i/v0/ai', { method: 'POST', body: fd, headers: { authorization: `Bearer ${p.api_token}` } }));
    expect(mp.status).toBe(200);
    const bad = new FormData(); bad.append('event', JSON.stringify({ event: '$pageview', distinct_id: 'x' }));
    expect((await W.fetch(new Request(SITE + '/i/v0/ai', { method: 'POST', body: bad, headers: { authorization: `Bearer ${p.api_token}` } }))).status).toBe(400);
    const extra = new FormData(); extra.append('event', JSON.stringify({ event: '$ai_generation', distinct_id: 'x' })); extra.append('blob', 'x');
    expect((await W.fetch(new Request(SITE + '/i/v0/ai', { method: 'POST', body: extra, headers: { authorization: `Bearer ${p.api_token}` } }))).status).toBe(400);
    expect((await W.fetch(new Request(SITE + '/i/v0/ai', { method: 'POST', body: extra }))).status).toBe(401);
    // v1 AI endpoint: an error generation on another model/provider, and a misrouted event.
    const t2 = 'trace-' + crypto.randomUUID();
    const g2 = gen(t2, { $ai_model: 'claude-3-5-haiku-20241022', $ai_provider: 'anthropic', $ai_is_error: true, $ai_error: 'overloaded', $ai_http_status: 529, $ai_latency: 3.1 });
    const v1 = await call('/i/v1/ai/events', { method: 'POST', headers: { authorization: `Bearer ${p.api_token}` }, body: JSON.stringify({ created_at: new Date().toISOString(), batch: [{ ...g2, timestamp: new Date().toISOString() }, { event: 'signup', distinct_id: 'x', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), properties: {} }] }) });
    expect(v1.status).toBe(200); expect(JSON.stringify(await v1.json())).toContain('misrouted_event');
    // Standard capture also carries AI events (posthog-node / posthog-python AI wrappers).
    await capture(p.api_token, [{ event: '$ai_embedding', distinct_id: 'llm-user', uuid: crypto.randomUUID(), properties: { $ai_trace_id: t2, $ai_model: 'text-embedding-3-small', $ai_provider: 'openai', $ai_input_tokens: 500, $ai_latency: 0.1 } }]);
    let ov: any;
    await vi.waitFor(async () => { ov = await j(call(`/api/projects/${p.id}/llm/overview`, { cookie })); expect(ov.totals.generations + ov.totals.embeddings).toBe(3); }, { timeout: 8000, interval: 200 });
    expect(ov.totals).toMatchObject({ generations: 2, embeddings: 1, traces: 2, errors: 1, input_tokens: 2500, output_tokens: 400 });
    expect(ov.totals.cost_usd).toBeGreaterThan(0); expect(ov.totals.latency_p50_ms).toBeGreaterThan(0); expect(ov.totals.error_rate).toBeCloseTo(1 / 3, 5);
    expect(ov.models.map((m: any) => m.provider).sort()).toEqual(['anthropic', 'openai', 'openai']);
    expect(ov.series.generations.reduce((a: number, b: number) => a + b, 0)).toBe(2);
    const events = await j(call(`/api/projects/${p.id}/events?limit=50`, { cookie }));
    expect(events.results.some((e: any) => e.event === '$pageview' || e.event === 'signup')).toBe(false);
    const tr = await j(call(`/api/projects/${p.id}/llm/traces`, { cookie }));
    expect(tr.total).toBe(2); expect(tr.facets.providers).toEqual(['anthropic', 'openai']);
    const t1row = tr.results.find((t: any) => t.id === t1);
    expect(t1row).toMatchObject({ name: 'support-bot', spans: 3, generations: 1, status: 'ok', latency_ms: 2500 });
    expect((await j(call(`/api/projects/${p.id}/llm/traces?status=error`, { cookie }))).results.map((t: any) => t.id)).toEqual([t2]);
    expect((await j(call(`/api/projects/${p.id}/llm/traces?provider=anthropic`, { cookie }))).total).toBe(1);
    expect((await j(call(`/api/projects/${p.id}/llm/traces?search=support`, { cookie }))).total).toBe(1);
    const d = await j(call(`/api/projects/${p.id}/llm/traces/${encodeURIComponent(t1)}?ts=${t1row.timestamp}`, { cookie }));
    expect(d).toMatchObject({ id: t1, name: 'support-bot', status: 'ok', input: { q: 'refund?' } });
    expect(d.tree.length).toBe(1); expect(d.tree[0]).toMatchObject({ event: '$ai_span', name: 'retrieve' });
    expect(d.tree[0].children[0]).toMatchObject({ event: '$ai_generation', name: 'answer', model: 'gpt-4o-mini', input_tokens: 1000, latency_ms: 800, input: [{ role: 'user', content: 'Hi' }], output: [{ role: 'assistant', content: 'Hello!' }] });
    expect(d.tree[0].children[0].offset_ms).toBeGreaterThanOrEqual(0);
    expect((await call(`/api/projects/${p.id}/llm/traces/nope`, { cookie })).status).toBe(404);
  });
});

describe('cold Trends', () => {
  const NOW = Date.parse('2026-11-19T12:00:00Z');
  const opts = { table: 'analytics.events', projectId: 7, retentionDays: 30, now: NOW, timezone: 'UTC' };
  it('compiles to one GROUP BY per series with forced project and retention filters', () => {
    const plan = buildColdTrends({ kind: 'TrendsQuery', interval: 'day', dateRange: { date_from: '-7d' }, series: [{ kind: 'EventsNode', event: '$pageview' }, { kind: 'EventsNode', event: 'signup', math: 'dau' }], properties: [{ key: '$browser', value: 'Chrome', operator: 'exact', type: 'event' }] }, opts);
    expect(plan.statements.length).toBe(2); expect(plan.buckets.length).toBe(8);
    const cutoff = NOW - 30 * 86400_000;
    for (const s of plan.statements) { expect(s).toContain('project_id = 7'); expect(s).toContain(`ts >= ${cutoff}`); expect(s).toContain('GROUP BY 1'); expect(s).toContain("json_get_str(properties, '$browser')"); }
    expect(plan.statements[0]).toContain("event = '$pageview'"); expect(plan.statements[1]).toContain('COUNT(DISTINCT distinct_id)');
    const res = coldTrendsResults(plan, [[{ b: 0, c: 3 }, { b: 7, c: 5 }], [{ b: 7, c: 2 }]]);
    expect(res[0]).toMatchObject({ label: '$pageview', count: 8 }); expect(res[0].data[7]).toBe(5); expect(res[1].count).toBe(2);
  });
  it('clamps to retention and rejects what only the hot engine can do', () => {
    const plan = buildColdTrends({ kind: 'TrendsQuery', interval: 'month', dateRange: { date_from: '-365d' }, series: [{ kind: 'EventsNode', event: 'a' }] }, opts);
    expect(plan.range.from).toBeGreaterThanOrEqual(NOW - 30 * 86400_000);
    const t = (q: any) => () => buildColdTrends({ kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: 'a' }], ...q }, opts);
    expect(t({ breakdownFilter: { breakdown: '$browser' } })).toThrow(/hot/);
    expect(t({ compareFilter: { compare: true } })).toThrow(/hot/);
    expect(t({ series: [{ kind: 'ActionsNode', id: 1 }] })).toThrow(/hot/);
    expect(t({ series: [{ kind: 'EventsNode', event: 'a', math: 'sum', math_property: 'x' }] })).toThrow(/hot/);
    expect(t({ interval: 'hour', dateRange: { date_from: '-30d' } })).toThrow(new RegExp(String(COLD_TRENDS_MAX_BUCKETS)));
    expect(() => buildColdTrends({ kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: 'a' }] }, { ...opts, projectId: 0 })).toThrow();
  });
  it('runs against Basin SQL and degrades when the cold tier is off', async () => {
    await expect(runColdTrends({} as any, { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: 'a' }] }, { projectId: 1, retentionDays: 30, timezone: 'UTC' })).rejects.toThrow(/not configured/);
    const seen: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => { seen.push(JSON.parse(init.body).query ?? JSON.parse(init.body).sql ?? ''); return new Response(JSON.stringify({ success: true, result: { rows: [{ b: 0, c: 4 }], metrics: { bytes_scanned: 100 } } }), { headers: { 'content-type': 'application/json' } }); });
    try {
      const cenv = { COLD_STREAM: {}, BASIN_TOKEN: 't', BASIN_ACCOUNT_ID: 'a', BASIN_BUCKET: 'b' } as any;
      const r = await runColdTrends(cenv, { kind: 'TrendsQuery', interval: 'day', dateRange: { date_from: '-3d' }, series: [{ kind: 'EventsNode', event: 'a' }] }, { projectId: 3, retentionDays: 0, timezone: 'UTC' });
      expect(r.source).toBe('cold'); expect(r.results[0].count).toBe(4); expect(seen[0]).toContain('project_id = 3');
    } finally { spy.mockRestore(); }
  });
  it('the query API answers a clear error for source: cold when not configured', async () => {
    const { cookie, p } = await owner();
    const r = await call(`/api/projects/${p.id}/query`, { method: 'POST', cookie, body: JSON.stringify({ source: 'cold', query: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: 'a' }] } }) });
    expect(r.status).toBe(400); expect(JSON.stringify(await r.json())).toMatch(/not configured/);
  });
});
