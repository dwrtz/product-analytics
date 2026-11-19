// ProjectStore: person processing (protocol.md 7) and insight math (design.md Queries) on a hand-checked dataset.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import V from '../spec/test-vectors.json';
import { normalize } from '../src/worker/capture';
import type { NormEvent } from '../src/worker/env';
import type { ProjectStore } from '../src/worker/store';

const E = env as any;
let n = 0;
const store = () => E.STORE.get(E.STORE.idFromName(`test:${++n}:${Math.random()}`)) as unknown as ProjectStore;
const NOW = Date.parse('2026-03-10T12:00:00Z');
function norm(raw: any, ts?: string): NormEvent {
  const r = normalize({ ...raw, timestamp: ts ?? raw.timestamp }, { now: NOW, sentAt: null, ip: null, geo: {} }, { v1: false, anonymizeIps: false });
  if ('drop' in r) throw new Error(r.drop);
  return r;
}

describe('persons (test-vectors.json persons)', () => {
  for (const sc of V.persons.scenarios as any[]) it(sc.name, async () => {
    const s = store();
    let t = Date.parse('2026-03-01T00:00:00Z');
    for (const ev of sc.events) await s.ingest([norm(ev, new Date(t += 1000).toISOString())]);
    const got = (await s.listPersons('', null)).results.sort((a: any, b: any) => a.distinct_ids.sort()[0].localeCompare(b.distinct_ids.sort()[0]));
    expect(got.length).toBe(sc.expect.persons.length);
    sc.expect.persons.forEach((p: any, i: number) => {
      expect([...got[i].distinct_ids].sort()).toEqual([...p.distinct_ids].sort());
      if (p.properties) expect(got[i].properties).toEqual(p.properties);
      if (p.is_identified !== undefined) expect(got[i].is_identified).toBe(p.is_identified);
    });
    if (sc.expect.events_by_person) for (const [did, count] of Object.entries(sc.expect.events_by_person)) {
      const person = got.find((p: any) => p.distinct_ids.includes(did));
      const ev: any = await s.query({ kind: 'EventsQuery', personId: person.id, limit: 100 }, { timezone: 'UTC', now: NOW });
      expect(ev.results.length).toBe(count);
    }
  });
  it('drops duplicate uuids', async () => {
    const s = store(); const e = norm({ event: 'x', distinct_id: 'd', uuid: '01890000-0000-7000-8000-0000000000aa' }, '2026-03-01T00:00:00Z');
    expect(await s.ingest([e, e])).toMatchObject({ inserted: 1, duplicates: 1 });
  });
});

// Dataset (UTC): A browses anonymously then identifies; B browses and buys twice; C stays anonymous.
const DATA: [string, any][] = [
  ['2026-03-08T09:00:00Z', { event: '$pageview', distinct_id: 'anon-a', properties: { $browser: 'Chrome', $process_person_profile: false, $session_id: 's1' } }],
  ['2026-03-08T09:01:00Z', { event: '$identify', distinct_id: 'user-a', properties: { $anon_distinct_id: 'anon-a', $session_id: 's1' }, $set: { email: 'a@example.com', plan: 'pro' } }],
  ['2026-03-08T09:02:00Z', { event: '$pageview', distinct_id: 'user-a', properties: { $browser: 'Chrome', $session_id: 's1' } }],
  ['2026-03-08T15:00:00Z', { event: '$pageview', distinct_id: 'user-b', properties: { $browser: 'Safari', $session_id: 's2' }, $set: { email: 'b@example.com', plan: 'free' } }],
  ['2026-03-09T10:00:00Z', { event: '$pageview', distinct_id: 'user-a', properties: { $browser: 'Chrome', $session_id: 's3' } }],
  ['2026-03-09T11:00:00Z', { event: '$pageview', distinct_id: 'user-b', properties: { $browser: 'Safari', $session_id: 's4' } }],
  ['2026-03-09T11:05:00Z', { event: 'purchase', distinct_id: 'user-b', properties: { amount: 30, $session_id: 's4' } }],
  ['2026-03-09T20:00:00Z', { event: '$pageview', distinct_id: 'anon-c', properties: { $process_person_profile: false, $session_id: 's5' } }],
  ['2026-03-10T08:00:00Z', { event: 'purchase', distinct_id: 'user-b', properties: { amount: 70, $session_id: 's6' } }],
  ['2026-03-10T09:00:00Z', { event: '$pageview', distinct_id: 'anon-c', properties: { $process_person_profile: false, $session_id: 's7' } }],
];
async function seeded() { const s = store(); await s.ingest(DATA.map(([t, e]) => norm(e, t))); return s; }
const qc = { timezone: 'UTC', now: NOW };
const pv = (extra: any = {}) => ({ kind: 'EventsNode', event: '$pageview', ...extra });

describe('trends', () => {
  it('total and unique persons per day, joining anonymous events to the identified person', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'TrendsQuery', series: [pv({ math: 'total' }), pv({ math: 'dau' }), pv({ math: 'unique_session' })], interval: 'day', dateRange: { date_from: '-7d' } }, qc);
    expect(r.results[0].labels.slice(-3)).toEqual(['2026-03-08', '2026-03-09', '2026-03-10']);
    expect(r.results[0].data).toEqual([0, 0, 0, 0, 0, 3, 3, 1]);
    expect(r.results[1].data).toEqual([0, 0, 0, 0, 0, 2, 3, 1]);
    expect(r.results[2].data.slice(-3)).toEqual([2, 3, 1]);
    expect(r.results[0].count).toBe(7);
  });
  it('sum of a property, as a number, with compare', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: 'purchase', math: 'sum', math_property: 'amount' }], interval: 'day', dateRange: { date_from: '-2d' }, trendsFilter: { display: 'BoldNumber' }, compareFilter: { compare: true } }, qc);
    expect(r.results.map((x: any) => [x.compare_label, x.aggregated_value])).toEqual([['current', 100], ['previous', 0]]);
  });
  it('breakdown by event property with a none bucket', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'TrendsQuery', series: [pv()], dateRange: { date_from: '-7d' }, breakdownFilter: { breakdown: '$browser', breakdown_type: 'event' }, trendsFilter: { display: 'ActionsBarValue' } }, qc);
    expect(Object.fromEntries(r.results.map((x: any) => [x.breakdown_value, x.aggregated_value]))).toEqual({ Chrome: 3, Safari: 2, $$_none_$$: 2 });
  });
  it('person property filter', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'TrendsQuery', series: [pv()], dateRange: { date_from: '-7d' }, properties: [{ key: 'plan', value: ['pro'], operator: 'exact', type: 'person' }], trendsFilter: { display: 'BoldNumber' } }, qc);
    expect(r.results[0].aggregated_value).toBe(3);
  });
  it('hours in a non-UTC zone', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'TrendsQuery', series: [pv()], interval: 'day', dateRange: { date_from: '2026-03-09', date_to: '2026-03-09' } }, { timezone: 'Asia/Kolkata', now: NOW });
    // 2026-03-09 in Kolkata is 03-08 18:30Z to 03-09 18:30Z: A and B on the 9th only.
    expect(r.results[0].data).toEqual([2]);
  });
  it('rejects an unknown operator', async () => {
    const s = await seeded();
    let msg = '';
    try { await s.query({ kind: 'TrendsQuery', series: [pv()], properties: [{ key: 'a', operator: 'nope' }] }, qc); } catch (e) { msg = String(e); }
    expect(msg).toMatch(/unsupported operator/);
  });
});

describe('funnels', () => {
  it('ordered: pageview then purchase within 14 days', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'FunnelsQuery', series: [pv(), { kind: 'EventsNode', event: 'purchase' }], funnelsFilter: { funnelWindowInterval: 14, funnelWindowIntervalUnit: 'day' }, dateRange: { date_from: '-7d' } }, qc);
    expect(r.results.map((x: any) => x.count)).toEqual([3, 1]);
    expect(r.results[1].median_conversion_time).toBe(5 * 60); // B: 03-09 11:00 pageview, 11:05 purchase
  });
  it('a 1 minute window drops slow conversions', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'FunnelsQuery', series: [pv(), { kind: 'EventsNode', event: 'purchase' }], funnelsFilter: { funnelWindowInterval: 1, funnelWindowIntervalUnit: 'minute' }, dateRange: { date_from: '-7d' } }, qc);
    expect(r.results.map((x: any) => x.count)).toEqual([3, 0]);
  });
  it('anonymous then identified steps count as one person', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'FunnelsQuery', series: [pv({ properties: [{ key: '$browser', value: ['Chrome'] }] }), { kind: 'EventsNode', event: '$identify' }], dateRange: { date_from: '-7d' } }, qc);
    expect(r.results.map((x: any) => x.count)).toEqual([1, 1]);
  });
});

describe('retention', () => {
  it('recurring, daily', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'RetentionQuery', retentionFilter: { targetEntity: { id: '$pageview', type: 'events' }, returningEntity: { id: '$pageview', type: 'events' }, period: 'Day', totalIntervals: 3 } }, qc);
    expect(r.results.map((x: any) => x.values.map((v: any) => v.count))).toEqual([[2, 2, 0], [3, 1], [1]]);
  });
  it('first time', async () => {
    const s = await seeded();
    const r: any = await s.query({ kind: 'RetentionQuery', retentionFilter: { targetEntity: { id: '$pageview', type: 'events' }, returningEntity: { id: '$pageview', type: 'events' }, period: 'Day', totalIntervals: 3, retentionType: 'retention_first_time' } }, qc);
    expect(r.results.map((x: any) => x.values.map((v: any) => v.count))).toEqual([[2, 2, 0], [1, 1], [0]]);
  });
});

describe('events, flags, retention purge', () => {
  it('pages newest first with a cursor', async () => {
    const s = await seeded();
    const a: any = await s.query({ kind: 'EventsQuery', limit: 4 }, qc);
    expect(a.results.map((e: any) => e.event)).toEqual(['$pageview', 'purchase', '$pageview', 'purchase']);
    expect(a.hasMore).toBe(true);
    const b: any = await s.query({ kind: 'EventsQuery', limit: 100, cursor: a.next }, qc);
    expect(a.results.length + b.results.length).toBe(DATA.length);
  });
  it('evaluates flags with stored person properties', async () => {
    const s = await seeded();
    await s.saveFlag(null, { key: 'pro-only', filters: { groups: [{ properties: [{ key: 'plan', value: ['pro'], operator: 'exact', type: 'person' }], rollout_percentage: 100 }] } });
    expect((await s.evaluateFlags('anon-a', {}))[0].enabled).toBe(true); // merged into A
    expect((await s.evaluateFlags('user-b', {}))[0].enabled).toBe(false);
    expect((await s.evaluateFlags('user-b', { plan: 'pro' }))[0].enabled).toBe(true); // request overrides win
  });
  it('purges events older than the cutoff', async () => {
    const s = await seeded();
    expect(await s.purge(Date.parse('2026-03-09T00:00:00Z'))).toBe(4);
    expect((await s.stats()).events).toBe(DATA.length - 4);
  });
});
