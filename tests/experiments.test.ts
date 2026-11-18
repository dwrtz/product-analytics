// Experiments (design.md "Experiments") and surveys (design.md "Surveys").
import { describe, it, expect, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { normalize } from '../src/worker/capture';
import type { NormEvent } from '../src/worker/env';
import { compare, probBBeatsA, binomialPosterior, poissonPosterior, rng, gamma, lgamma } from '../src/shared/stats';
import SF from './fixtures/survey-events.json';

const E = env as any;
const W = (exports as any).default;
const SITE = 'http://app.test';
let n = 0;
const store = () => E.STORE.get(E.STORE.idFromName(`exp:${++n}:${Math.random()}`));
const NOW = Date.parse('2026-04-01T00:00:00Z');
let u = 0;
const ev = (event: string, did: string, ts: number, properties: any = {}): NormEvent => {
  const r = normalize({ event, distinct_id: did, timestamp: new Date(ts).toISOString(), uuid: `0191${String(++u).padStart(4, '0')}-0000-7000-8000-${String(u).padStart(12, '0')}`, properties }, { now: NOW, sentAt: null, ip: null, geo: {} }, { v1: false, anonymizeIps: false });
  if ('drop' in r) throw new Error(r.drop); return r;
};

describe('statistics', () => {
  it('lgamma matches known values', () => {
    expect(lgamma(1)).toBeCloseTo(0, 10); expect(lgamma(5)).toBeCloseTo(Math.log(24), 10); expect(lgamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 8);
  });
  it('gamma sampler has the right mean', () => {
    const r = rng(7); let t = 0; for (let i = 0; i < 20000; i++) t += gamma(r, 3.5); expect(t / 20000).toBeCloseTo(3.5, 1);
    let t2 = 0; for (let i = 0; i < 20000; i++) t2 += gamma(r, 0.4); expect(t2 / 20000).toBeCloseTo(0.4, 1);
  });
  it('Monte Carlo P(best) agrees with the closed form for two Beta posteriors', () => {
    for (const [sa, na, sb, nb] of [[40, 400, 60, 400], [10, 100, 12, 100], [5, 50, 5, 50], [100, 1000, 130, 1000]]) {
      const A = binomialPosterior(sa, na), B = binomialPosterior(sb, nb);
      const exact = probBBeatsA((A as any).a, (A as any).b, (B as any).a, (B as any).b);
      const mc = compare([A, B]).probability_to_be_best[1];
      expect(Math.abs(mc - exact)).toBeLessThan(0.012);
    }
  });
  it('is deterministic for a seed and sums to 1', () => {
    const ps = [poissonPosterior(100, 50), poissonPosterior(130, 50), poissonPosterior(90, 50)];
    const a = compare(ps), b = compare(ps);
    expect(a).toEqual(b);
    expect(a.probability_to_be_best.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
    expect(a.probability_to_be_best[1]).toBeGreaterThan(0.9);
  });
});

describe('experiments', () => {
  it('creates an inactive multivariate flag, launches, and computes exposure-gated results', async () => {
    const s = store();
    const t0 = NOW - 10 * 86400_000;
    const e: any = await s.saveExperiment(null, { name: 'Checkout', feature_flag_key: 'checkout-exp', metrics: [
      { kind: 'funnel', series: [{ event: 'purchase' }] },
      { kind: 'count', event: { event: '$pageview' } },
      { kind: 'continuous', event: { event: 'purchase' }, math_property: 'amount' }] });
    expect(e.status).toBe('draft'); expect(e.variants.map((v: any) => v.key)).toEqual(['control', 'test']);
    expect((await s.listFlags())[0]).toMatchObject({ key: 'checkout-exp', active: false });
    const launched: any = await s.saveExperiment(e.id, { action: 'launch' });
    expect(launched.status).toBe('running'); expect((await s.listFlags())[0].active).toBe(true);
    // Rewrite the start date so the dataset (10 days back) falls inside the experiment.
    await (await import('cloudflare:test')).runInDurableObject(s, async (inst: any) => { inst.sql.exec('UPDATE experiments SET start_date = ?', t0); });
    const evs: NormEvent[] = [];
    for (let i = 0; i < 200; i++) {
      const v = i % 2 ? 'test' : 'control'; const did = `p${i}`; const t = t0 + 3600_000 + i * 60_000;
      evs.push(ev('purchase', did, t - 1000, { amount: 999 })); // before exposure: ignored
      evs.push(ev('$feature_flag_called', did, t, { $feature_flag: 'checkout-exp', $feature_flag_response: v }));
      evs.push(ev('$feature_flag_called', did, t + 5, { $feature_flag: 'other-flag', $feature_flag_response: true }));
      const converts = v === 'test' ? i % 10 < 5 : i % 10 < 2; // 40% vs 20%
      if (converts) evs.push(ev('purchase', did, t + 60_000, { amount: v === 'test' ? 30 : 20 }));
      evs.push(ev('$pageview', did, t + 1000)); if (v === 'test') evs.push(ev('$pageview', did, t + 2000));
    }
    evs.push(ev('$feature_flag_called', 'p0', t0 + 7200_000 * 60, { $feature_flag: 'checkout-exp', $feature_flag_response: 'test' })); // p0 saw both: excluded
    await s.ingest(evs);
    const r: any = await s.experimentResults(e.id, NOW);
    expect(r.variants).toEqual([{ key: 'control', exposures: 99 }, { key: 'test', exposures: 100 }]);
    expect(r.multiple_variant_persons).toBe(1);
    const [funnel, count, cont] = r.metrics;
    expect(funnel.variants[0].conversions).toBe(19); expect(funnel.variants[1].conversions).toBe(40); // odd i with i % 10 in {1, 3}
    expect(funnel.significant).toBe(true); expect(funnel.winner).toBe('test');
    expect(funnel.variants[1].probability_to_be_best).toBeGreaterThan(0.99);
    expect(funnel.variants[1].uplift).toBeGreaterThan(0.8);
    expect(count.variants[0].count).toBe(99); expect(count.variants[1].count).toBe(200); expect(count.winner).toBe('test');
    expect(cont.variants[0].sum).toBe(19 * 20); expect(cont.variants[1].sum).toBe(40 * 30);
    const stopped: any = await s.saveExperiment(e.id, { action: 'stop' });
    expect(stopped.status).toBe('complete');
  });
  it('needs 50 exposures per variant before calling a winner', async () => {
    const s = store();
    const e: any = await s.saveExperiment(null, { name: 'Small', feature_flag_key: 'small', metrics: [{ kind: 'funnel', series: [{ event: 'buy' }] }] });
    await s.saveExperiment(e.id, { action: 'launch' });
    const t = Date.now() - 1000; const evs = [];
    for (let i = 0; i < 20; i++) { evs.push(ev('$feature_flag_called', `q${i}`, t, { $feature_flag: 'small', $feature_flag_response: i % 2 ? 'test' : 'control' })); if (i % 2) evs.push(ev('buy', `q${i}`, t + 10)); }
    await s.ingest(evs);
    const r: any = await s.experimentResults(e.id);
    expect(r.metrics[0].significant).toBe(false); expect(r.metrics[0].reason).toMatch(/50 exposures/);
  });
  it('rejects a non-multivariate flag and bad metrics', async () => {
    const s = store();
    await s.saveFlag(null, { key: 'plain' });
    expect(await s.saveExperiment(null, { name: 'x', feature_flag_key: 'plain' })).toEqual({ error: 'that flag has no variants; use a multivariate flag' });
    expect((await s.saveExperiment(null, { name: 'x', feature_flag_key: 'y', metrics: [{ kind: 'nope' }] }) as any).error).toMatch(/metric kind/);
  });
});

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set('cookie', init.cookie);
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && path.startsWith('/api/')) h.set('origin', SITE);
  return W.fetch(new Request(SITE + path, { ...init, headers: h })) as Promise<Response>;
};
async function owner() {
  const body = JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' });
  let r = await call('/api/signup', { method: 'POST', body });
  if (r.status !== 201) r = await call('/api/login', { method: 'POST', body });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const p = await (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Surveys', timezone: 'UTC' }), cookie })).json() as any;
  return { cookie, p };
}

describe('surveys', () => {
  it('CRUD, posthog-js /api/surveys, remote config and results from the SDK events', async () => {
    const { cookie, p } = await owner();
    const body = { name: 'NPS', type: 'popover', questions: [
      { type: 'rating', id: 'q-rating', question: 'How likely are you to recommend us?', display: 'number', scale: 10, lowerBoundLabel: 'Unlikely', upperBoundLabel: 'Very likely' },
      { type: 'single_choice', id: 'q-choice', question: 'What brought you here?', choices: ['Search', 'Friend', 'Ad'] },
      { type: 'open', id: 'q-open', question: 'Anything else?' }], conditions: { events: { values: [{ name: 'opened_pricing' }] } } };
    const c = await call(`/api/projects/${p.id}/surveys`, { method: 'POST', cookie, body: JSON.stringify(body) });
    expect(c.status).toBe(201);
    const sv = await c.json() as any;
    expect(sv).toMatchObject({ status: 'draft', appearance: { whiteLabel: true }, start_date: null });
    expect((await (await call(`/api/surveys/?token=${p.api_token}`)).json() as any).surveys).toEqual([]);
    expect((await call('/api/surveys/')).status).toBe(401);
    await call(`/api/projects/${p.id}/surveys/${sv.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ action: 'launch' }) });
    const pub = (await (await call(`/api/surveys/?token=${p.api_token}&_=1`)).json() as any).surveys;
    expect(pub).toHaveLength(1);
    expect(pub[0]).toMatchObject({ id: sv.id, type: 'popover', questions: [{ id: 'q-rating', scale: 10 }, { id: 'q-choice', choices: ['Search', 'Friend', 'Ad'] }, { id: 'q-open' }], conditions: { events: { values: [{ name: 'opened_pricing' }] } } });
    expect(typeof pub[0].start_date).toBe('string');
    expect(((await (await call(`/array/${p.api_token}/config`)).json()) as any).surveys).toBe(true);
    // The REA-captured posthog-js events, retargeted at this survey and project.
    const batch = JSON.parse(JSON.stringify(SF.events).replaceAll(SF.survey_id, sv.id)).map((e: any) => ({ ...e, timestamp: new Date().toISOString() }));
    expect((await call('/batch/', { method: 'POST', body: JSON.stringify({ api_key: p.api_token, batch }) })).status).toBe(200);
    let r: any;
    await vi.waitFor(async () => { r = await (await call(`/api/projects/${p.id}/surveys/${sv.id}/results`, { cookie })).json(); expect(r.sent.responses).toBe(1); }, { timeout: 8000, interval: 200 });
    expect(r.shown).toEqual({ events: 1, persons: 1 });
    expect(r.response_rate).toBe(1);
    const [rating, choice, open] = r.questions;
    expect(rating.distribution.find((d: any) => d.value === 9).count).toBe(1); expect(rating.nps).toBe(100);
    expect(choice.choices).toEqual([{ choice: 'Search', count: 0 }, { choice: 'Friend', count: 1 }, { choice: 'Ad', count: 0 }]);
    expect(open.latest[0].value).toBe('Great product');
    await call(`/api/projects/${p.id}/surveys/${sv.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ action: 'stop' }) });
    expect((await (await call(`/api/surveys/?token=${p.api_token}`)).json() as any).surveys).toEqual([]);
    expect((await call(`/api/projects/${p.id}/surveys/${sv.id}`, { method: 'DELETE', cookie })).status).toBe(200);
  });
  it('validates questions', async () => {
    const { cookie, p } = await owner();
    const r = await call(`/api/projects/${p.id}/surveys`, { method: 'POST', cookie, body: JSON.stringify({ name: 'Bad', questions: [{ type: 'single_choice', question: 'Pick', choices: ['one'] }] }) });
    expect(r.status).toBe(400);
  });
});
