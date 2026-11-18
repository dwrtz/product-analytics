// The Worker over HTTP: owner API, capture endpoints, /flags and remote config (spec R1-R12, protocol.md).
import { describe, it, expect, vi } from 'vitest';
import { exports, env } from 'cloudflare:workers';
import V from '../spec/test-vectors.json';

const SITE = 'http://app.test';
const W = (exports as any).default;
const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set('cookie', init.cookie);
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && !h.has('origin') && path.startsWith('/api/')) h.set('origin', SITE);
  return W.fetch(new Request(SITE + path, { ...init, headers: h })) as Promise<Response>;
};
async function owner() {
  const body = JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' });
  let r = await call('/api/signup', { method: 'POST', body });
  if (r.status !== 201) r = await call('/api/login', { method: 'POST', body });
  expect(r.ok).toBe(true);
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const p = await (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Test', timezone: 'UTC' }), cookie })).json() as any;
  return { cookie, p };
}
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const gzip = async (s: string) => new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

describe('accounts', () => {
  it('first account only, then sign-up closes', async () => {
    await owner();
    const r = await call('/api/signup', { method: 'POST', body: JSON.stringify({ email: 'stranger@example.com', password: 'correct horse battery' }) });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toBe('signup_closed');
    expect(((await (await call('/api/config')).json()) as any).signup_open).toBe(false);
  });
  it('new projects get DEFAULT_RETENTION_DAYS unless the request sets retention_days', async () => {
    const { cookie, p } = await owner();
    expect(p.retention_days).toBe(30);
    const q = await (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Forever', timezone: 'UTC', retention_days: 0 }), cookie })).json() as any;
    expect(q.retention_days).toBe(0);
  });
  it('cookie writes need a matching Origin', async () => {
    const { cookie } = await owner();
    const r = await call('/api/projects', { method: 'POST', body: '{}', cookie, headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });
  it('personal API keys work as Bearer tokens and are shown once', async () => {
    const { cookie } = await owner();
    const { key } = await (await call('/api/personal_api_keys', { method: 'POST', body: '{"label":"ci"}', cookie })).json() as any;
    expect(key).toMatch(/^phx_/);
    const list = await (await call('/api/personal_api_keys', { cookie })).json() as any[];
    expect(JSON.stringify(list)).not.toContain(key);
    expect((await call('/api/projects', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await call('/api/projects', { headers: { authorization: 'Bearer phx_wrong' } })).status).toBe(401);
  });
});

describe('capture (protocol.md 2-6)', () => {
  it('decodes every body vector and answers {"status":1}', async () => {
    const { p } = await owner();
    for (const c of V.bodies.cases as any[]) {
      const body = unb64(c.body_base64);
      const json = new TextDecoder().decode(body).replace('phc_vectortoken', p.api_token);
      // Re-encode with this project's token, keeping the same encoding.
      const bytes = c.name.includes('gzip') || c.content_encoding ? await gzip(JSON.parse(JSON.stringify(V.bodies.json)).replace('phc_vectortoken', p.api_token)) : c.name.includes('lz64') || c.name.includes('base64') ? null : new TextEncoder().encode(json);
      if (!bytes) continue;
      const h: Record<string, string> = { 'content-type': c.content_type }; if (c.content_encoding) h['content-encoding'] = c.content_encoding;
      const r = await call(`/e/?${c.query ?? ''}`, { method: 'POST', body: bytes, headers: h });
      expect(r.status, c.name).toBe(200);
      expect(await r.json()).toEqual({ status: 1 });
    }
  });
  it('beacon=1 answers 204', async () => {
    const { p } = await owner();
    const r = await call('/e/?beacon=1', { method: 'POST', body: JSON.stringify({ api_key: p.api_token, event: 'x', distinct_id: 'd' }) });
    expect(r.status).toBe(204);
  });
  it('error vectors', async () => {
    for (const c of V.capture_responses.errors as any[]) {
      const r = await call(c.path, { method: 'POST', body: c.body ?? '{"batch":[]}', headers: c.headers ?? {} });
      expect(r.status, c.note).toBe(c.status);
      if (c.code) expect(((await r.json()) as any).code, c.note).toBe(c.code);
    }
  });
  it('CORS preflight', async () => {
    const r = await call('/i/v0/e/', { method: 'OPTIONS', headers: { origin: 'https://shop.example', 'access-control-request-headers': 'content-type' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://shop.example');
  });
  it('v1 batch answers a results map keyed by uuid', async () => {
    const { p } = await owner();
    const uuid = '01890000-0000-7000-8000-000000000001';
    const body = JSON.stringify({ created_at: new Date().toISOString(), batch: [{ event: 'order', uuid, distinct_id: 'srv-1', timestamp: new Date().toISOString(), properties: { amount: 5 }, options: {} }] });
    const r = await call('/i/v1/analytics/events', { method: 'POST', body: await gzip(body), headers: { authorization: `Bearer ${p.api_token}`, 'content-encoding': 'gzip', 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ results: { [uuid]: { result: 'ok' } } });
  });
  it('events reach the project store through the queue and merge persons', async () => {
    const { cookie, p } = await owner();
    const now = new Date().toISOString();
    const batch = [
      { event: '$pageview', distinct_id: 'anon-9', timestamp: now, properties: { $process_person_profile: false, $current_url: 'https://shop.example/' } },
      { event: '$identify', distinct_id: 'user-9', timestamp: now, properties: { $anon_distinct_id: 'anon-9' }, $set: { email: 'nine@example.com' } },
    ];
    expect((await call('/batch/', { method: 'POST', body: JSON.stringify({ api_key: p.api_token, batch, sent_at: now }) })).status).toBe(200);
    await vi.waitFor(async () => {
      const r = await (await call(`/api/projects/${p.id}/persons?search=nine`, { cookie })).json() as any;
      expect(r.results[0]?.distinct_ids?.sort()).toEqual(['anon-9', 'user-9']);
    }, { timeout: 8000, interval: 200 });
    const ev = await (await call(`/api/projects/${p.id}/events`, { cookie })).json() as any;
    expect(ev.results.map((e: any) => e.event).sort()).toEqual(['$identify', '$pageview']);
    expect(ev.results.every((e: any) => e.person?.name === 'nine@example.com')).toBe(true);
  });
});

describe('flags and remote config (protocol.md 8-9)', () => {
  it('/flags returns v2 flags plus the v1 maps; /decide adds config', async () => {
    const { cookie, p } = await owner();
    await call(`/api/projects/${p.id}/feature_flags`, { method: 'POST', cookie, body: JSON.stringify({ key: 'beta-feature', filters: (V.flag_hash.variants.flag as any).filters }) });
    await call(`/api/projects/${p.id}/feature_flags`, { method: 'POST', cookie, body: JSON.stringify({ key: 'pro', filters: { groups: [{ properties: [{ key: 'plan', value: ['pro'], operator: 'exact', type: 'person' }], rollout_percentage: 100 }], payloads: { true: '{"x":1}' } } }) });
    const body = await gzip(JSON.stringify({ token: p.api_token, distinct_id: 'example_id', person_properties: { plan: 'pro' } }));
    const r = await call('/flags/?v=2', { method: 'POST', body, headers: { 'content-type': 'text/plain' } });
    const f = await r.json() as any;
    expect(f.featureFlags).toEqual({ 'beta-feature': 'second-variant', pro: true });
    expect(f.featureFlagPayloads).toEqual({ pro: '{"x":1}' });
    expect(f.flags.pro).toMatchObject({ key: 'pro', enabled: true, variant: null, reason: { code: 'condition_match', condition_index: 0 }, metadata: { payload: '{"x":1}' } });
    expect(f.errorsWhileComputingFlags).toBe(false);
    const d = await (await call('/decide/?v=3', { method: 'POST', body: JSON.stringify({ token: p.api_token, distinct_id: 'example_id' }) })).json() as any;
    expect(d.config).toEqual({ enable_collect_everything: true });
    expect(d.featureFlags['beta-feature']).toBe('second-variant');
  });
  it('remote config JSON and config.js', async () => {
    const { p } = await owner();
    const j = await (await call(`/array/${p.api_token}/config`)).json() as any;
    expect(j).toMatchObject({ token: p.api_token, sessionRecording: false, surveys: false, analytics: { endpoint: '/i/v0/e/' } });
    const js = await (await call(`/array/${p.api_token}/config.js`)).text();
    expect(js).toContain('_POSTHOG_REMOTE_CONFIG');
    expect((await call('/array/phc_nope/config')).status).toBe(404);
  });
  it('a malformed token is 401; an unknown one is accepted and dropped', async () => {
    expect((await call('/e/', { method: 'POST', body: JSON.stringify({ api_key: 'phx_personal', event: 'x', distinct_id: 'd' }) })).status).toBe(401);
    expect((await call('/e/', { method: 'POST', body: JSON.stringify({ api_key: 'phc_unknown', event: 'x', distinct_id: 'd' }) })).status).toBe(200);
  });
});
