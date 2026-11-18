// Event shards (design.md "Event shards"): the same data stored as day shards, month shards, or half in the head's legacy
// events table must answer every query identically.
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { normalize } from '../src/worker/capture';
import type { NormEvent } from '../src/worker/env';
import type { ProjectStore } from '../src/worker/store';

const E = env as any;
const NOW = Date.parse('2026-03-20T12:00:00Z');
let n = 0;
const stub = () => E.STORE.get(E.STORE.idFromName(`shards:${++n}:${Math.random()}`));
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

function dataset(): NormEvent[] {
  const r = rng(42); const out: NormEvent[] = [];
  const browsers = ['Chrome', 'Safari', 'Firefox'];
  for (let i = 0; i < 600; i++) {
    const u = Math.floor(r() * 40); const ts = NOW - Math.floor(r() * 50 * 86400_000);
    const identified = u % 3 === 0;
    const did = identified && r() < 0.5 ? `user-${u}` : `anon-${u}`;
    const roll = r();
    const event = roll < 0.55 ? '$pageview' : roll < 0.75 ? 'signup' : roll < 0.9 ? 'purchase' : '$identify';
    const raw: any = { event, distinct_id: event === '$identify' ? `user-${u}` : did, properties: { $browser: browsers[u % 3], $session_id: `s${u}-${Math.floor(ts / 3600_000)}`, amount: Math.round(r() * 100) } };
    if (event === '$identify') { raw.properties.$anon_distinct_id = `anon-${u}`; raw.$set = { plan: u % 2 ? 'pro' : 'free', email: `u${u}@example.com` }; }
    if (!identified && event !== '$identify') raw.properties.$process_person_profile = u % 2 === 0 ? false : undefined;
    const e = normalize({ ...raw, uuid: `0190${String(i).padStart(4, '0')}-0000-7000-8000-000000000000`, timestamp: new Date(ts).toISOString() }, { now: NOW, sentAt: null, ip: null, geo: {} }, { v1: false, anonymizeIps: false });
    if ('drop' in e) throw new Error(e.drop);
    out.push(e);
  }
  return out;
}

const QUERIES: any[] = [
  { kind: 'TrendsQuery', series: [{ event: '$pageview' }, { event: '$pageview', math: 'dau' }, { event: '$pageview', math: 'unique_session' }], interval: 'day', dateRange: { date_from: '-30d' } },
  { kind: 'TrendsQuery', series: [{ event: 'purchase', math: 'sum', math_property: 'amount' }, { event: 'purchase', math: 'avg', math_property: 'amount' }, { event: 'purchase', math: 'median', math_property: 'amount' }, { event: 'purchase', math: 'max', math_property: 'amount' }], interval: 'week', dateRange: { date_from: '-60d' } },
  { kind: 'TrendsQuery', series: [{ event: '$pageview', math: 'dau' }], dateRange: { date_from: '-45d' }, breakdownFilter: { breakdown: 'plan', breakdown_type: 'person' }, trendsFilter: { display: 'ActionsBarValue' } },
  { kind: 'TrendsQuery', series: [{ event: null }], interval: 'month', dateRange: { date_from: 'all' }, breakdownFilter: { breakdown: '$browser', breakdown_limit: 2 } },
  { kind: 'TrendsQuery', series: [{ event: 'signup' }], dateRange: { date_from: '-14d' }, properties: [{ key: 'plan', value: ['pro'], type: 'person' }], compareFilter: { compare: true } },
  { kind: 'FunnelsQuery', series: [{ event: '$pageview' }, { event: 'signup' }, { event: 'purchase' }], dateRange: { date_from: '-40d' }, funnelsFilter: { funnelWindowInterval: 7, funnelWindowIntervalUnit: 'day' } },
  { kind: 'FunnelsQuery', series: [{ event: '$pageview' }, { event: 'purchase' }], dateRange: { date_from: '-40d' }, funnelsFilter: { funnelOrderType: 'unordered' }, breakdownFilter: { breakdown: 'plan', breakdown_type: 'person' } },
  { kind: 'RetentionQuery', retentionFilter: { targetEntity: { id: 'signup', type: 'events' }, returningEntity: { id: '$pageview', type: 'events' }, period: 'Week', totalIntervals: 6 } },
  { kind: 'RetentionQuery', retentionFilter: { targetEntity: { id: '$pageview', type: 'events' }, returningEntity: { id: '$pageview', type: 'events' }, period: 'Day', totalIntervals: 10, retentionType: 'retention_first_time' } },
];
const qc = { timezone: 'UTC', now: NOW };
/** Float sums depend on row order across shards; compare at 9 significant digits. */
const R = (v: any): any => typeof v === 'number' ? Number(v.toPrecision(9)) : Array.isArray(v) ? v.map(R) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, R(x)])) : v;

async function allEvents(s: ProjectStore) {
  const out: any[] = []; let cursor: string | null = null;
  for (;;) { const r: any = await s.query({ kind: 'EventsQuery', limit: 37, cursor }, qc); out.push(...r.results.map((e: any) => e.uuid)); if (!r.next) break; cursor = r.next; }
  return out;
}

describe('event shards', () => {
  it('day shards, month shards and legacy+shards answer identically', async () => {
    const data = dataset();
    const day = stub(); await day.ingest(data);
    const month = stub();
    await runInDurableObject(month, async (inst: any) => { inst.sql.exec("INSERT INTO meta (key, value) VALUES ('shard_period', 'month')"); });
    await month.ingest(data);
    // Mixed: the first half arrives before the upgrade (straight into the legacy head table), the rest through shards.
    const mixed = stub();
    await mixed.ingest(data.slice(300));
    await runInDurableObject(mixed, async (inst: any) => {
      for (const e of data.slice(0, 300)) inst.sql.exec('INSERT INTO events (uuid, event, distinct_id, timestamp, properties, created_at) VALUES (?, ?, ?, ?, ?, ?)', e.uuid, e.event, e.distinct_id, e.ts, JSON.stringify(e.properties), e.received_at);
      inst.legacyRows = null;
    });
    // Persons for the legacy half come from re-ingesting it: ingest_log does not know these uuids, but the legacy table does,
    // so they are skipped as duplicates; process persons by ingesting into a fresh store instead and compare person-free queries.
    const ds: any = await day.stats(), ms: any = await month.stats();
    expect(ds.events).toBe(600); expect(ms.events).toBe(600); expect(ds.shards).toBeGreaterThan(40); expect(ms.shards).toBeLessThanOrEqual(3);
    for (const q of QUERIES) expect(R(await month.query(q, qc)), JSON.stringify(q)).toEqual(R(await day.query(q, qc)));
    expect(await allEvents(month)).toEqual(await allEvents(day));
    const ev = await allEvents(mixed); expect(ev).toEqual(await allEvents(day));
    expect((await mixed.ingest(data.slice(0, 10))).duplicates).toBe(10);
    for (const q of QUERIES.filter(q => q.kind === 'TrendsQuery' && !JSON.stringify(q).includes('person') && !JSON.stringify(q).includes('dau')))
      expect(R(await mixed.query(q, qc))).toEqual(R(await day.query(q, qc)));
  });

  it('retention purge drops whole shards and trims the boundary one', async () => {
    const s = stub(); const data = dataset(); await s.ingest(data);
    const cutoff = NOW - 20 * 86400_000 + 3600_000;
    const removed = await s.purge(cutoff);
    expect(removed).toBe(data.filter(e => e.ts < cutoff).length);
    expect((await s.stats()).events).toBe(data.filter(e => e.ts >= cutoff).length);
  });

  it('deleting a person with events removes them from every shard', async () => {
    const s = stub(); await s.ingest(dataset());
    const p: any = (await s.listPersons('u3@example.com', null)).results[0];
    const before: any = await s.query({ kind: 'EventsQuery', personId: p.id, limit: 1000 }, qc);
    expect(before.results.length).toBeGreaterThan(3);
    await s.deletePerson(p.id, true);
    const left: any = await s.query({ kind: 'EventsQuery', limit: 1000 }, qc);
    expect(left.results.some((e: any) => p.distinct_ids.includes(e.distinct_id))).toBe(false);
  });
});
