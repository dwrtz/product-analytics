// Insight queries (design.md "Queries"), run by the head ProjectStore as a two-phase plan: every event shard whose period
// overlaps the range runs event-level SQL (eventsql.ts) and returns rows keyed by distinct_id; the head maps distinct ids to
// persons, applies person filters and person breakdowns, and aggregates. Results are exact. All times are ms UTC.
import { buckets, resolveRange, startOf, addInterval, label as bucketLabel, Interval } from '../shared/dates';
import { NONE, QueryError, PropertyFilter, NodeSpec, TrendSpec, FunnelSpec, PeriodSpec, EventsSpec, EventRow, isPersonFilter, matchPerson, textOf, validateFilters } from './eventsql';
export { QueryError } from './eventsql';
export type { PropertyFilter } from './eventsql';

export type QueryContext = { timezone: string; now?: number };
export type EventsNode = { kind?: 'EventsNode'; event?: string | null; name?: string; custom_name?: string; math?: string; math_property?: string; math_group_type_index?: number; properties?: PropertyFilter[] };
export interface ShardApi {
  trend(s: TrendSpec): Promise<unknown[][]>;
  funnel(s: FunnelSpec): Promise<unknown[][]>;
  periods(s: PeriodSpec): Promise<unknown[][]>;
  firsts(s: { node: NodeSpec; global?: PropertyFilter[]; before: number }): Promise<unknown[][]>;
  events(s: EventsSpec): Promise<EventRow[]>;
}
export type PersonRef = { pk: string; uuid: string | null; props: Record<string, unknown> };
export interface Engine {
  /** Shards whose period overlaps [from, to], oldest first. */
  shards(from: number, to: number): Promise<ShardApi[]>;
  resolve(dids: string[]): Map<string, PersonRef>;
  groupTypeName(idx: number): string | null;
  firstEventAt(): Promise<number | null>;
  distinctIdsOfPerson(uuid: string): string[];
}

const OTHER = '$$_other_$$';
const AGG_DISPLAYS = new Set(['BoldNumber', 'ActionsTable', 'ActionsPie', 'ActionsBarValue']);
const MATHS = new Set(['total', 'dau', 'unique_session', 'unique_group', 'sum', 'avg', 'min', 'max', 'median', 'p75', 'p90', 'p95', 'p99']);
const PCT: Record<string, number> = { median: 0.5, p75: 0.75, p90: 0.9, p95: 0.95, p99: 0.99 };
const breakdownLabel = (v: string) => v === NONE ? 'None' : v === OTHER ? 'Other' : v;
const personFilters = (fs: PropertyFilter[] | undefined) => (fs ?? []).filter(f => f && f.key && isPersonFilter(f));
const node = (n: EventsNode): NodeSpec => ({ event: n.event ?? null, properties: n.properties });
const concat = async <T>(ps: Promise<T[]>[]) => (await Promise.all(ps)).flat();

export function percentile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Person lookup for a set of rows, plus a predicate for person filters. */
function people(en: Engine, dids: Iterable<string>) {
  const m = en.resolve([...new Set(dids)]);
  const get = (d: string): PersonRef => m.get(d) ?? { pk: 'd' + d, uuid: null, props: {} };
  return { get, ok: (d: string, fs: PropertyFilter[]) => !fs.length || fs.every(f => matchPerson(f, get(d).props)) };
}

export async function runQuery(en: Engine, q: any, qc: QueryContext): Promise<unknown> {
  if (!q || typeof q !== 'object') throw new QueryError('query must be an object');
  validateFilters(q.properties);
  for (const s of Array.isArray(q.series) ? q.series : []) validateFilters(s?.properties);
  switch (q.kind) {
    case 'TrendsQuery': return trends(en, q, qc);
    case 'FunnelsQuery': return funnels(en, q, qc);
    case 'RetentionQuery': return retention(en, q, qc);
    case 'EventsQuery': return eventsQuery(en, q);
    default: throw new QueryError(`unsupported query kind ${q.kind}`);
  }
}

// ---------------- Trends ----------------
async function trends(en: Engine, q: any, qc: QueryContext) {
  const tz = qc.timezone, now = qc.now ?? Date.now();
  const series: EventsNode[] = Array.isArray(q.series) && q.series.length ? q.series : [{ event: '$pageview' }];
  if (series.length > 20) throw new QueryError('at most 20 series');
  const interval: Interval = ['hour', 'day', 'week', 'month'].includes(q.interval) ? q.interval : 'day';
  const range = resolveRange(q.dateRange?.date_from, q.dateRange?.date_to, tz, now, q.dateRange?.date_from === 'all' ? await en.firstEventAt() : null);
  const display = q.trendsFilter?.display ?? 'ActionsLineGraph';
  const aggregated = AGG_DISPLAYS.has(display);
  const run = async (r: { from: number; to: number }, compareLabel?: string) => {
    const bks = aggregated ? [{ start: r.from, end: r.to + 1, label: `${bucketLabel(r.from, 'day', tz)} - ${bucketLabel(r.to, 'day', tz)}` }] : buckets(r, interval, tz);
    if (bks.length > 2000) throw new QueryError('too many intervals; pick a larger interval');
    const out: any[] = [];
    for (let i = 0; i < series.length; i++) out.push(...await trendSeries(en, q, series[i], i, bks, r, aggregated, compareLabel));
    return out;
  };
  let results = await run(range, q.compareFilter?.compare ? 'current' : undefined);
  if (q.compareFilter?.compare) {
    const len = range.to - range.from;
    const pres = await run({ from: range.from - len - 1, to: range.from - 1 }, 'previous');
    // Previous-period series use the current period's labels, aligned by index.
    for (const p of pres) { const cur = results.find(r => r.action.order === p.action.order && r.breakdown_value === p.breakdown_value); if (cur) { p.labels = cur.labels; p.days = cur.days; } }
    results = [...results, ...pres];
  }
  return { kind: 'TrendsQuery', results, timezone: tz, interval, date_from: new Date(range.from).toISOString(), date_to: new Date(range.to).toISOString() };
}

async function trendSeries(en: Engine, q: any, s: EventsNode, order: number, bks: { start: number; end: number; label: string }[], range: { from: number; to: number }, aggregated: boolean, compareLabel?: string) {
  const math = s.math ?? 'total';
  if (!MATHS.has(math)) throw new QueryError(`unsupported math ${math}`);
  const numeric = ['sum', 'avg', 'min', 'max', 'median', 'p75', 'p90', 'p95', 'p99'].includes(math);
  if (numeric && !s.math_property) throw new QueryError(`math ${math} needs math_property`);
  let extra: TrendSpec['extra'] = null;
  if (math === 'unique_session') extra = 'session';
  if (math === 'unique_group') { const g = en.groupTypeName(Number(s.math_group_type_index ?? 0)); if (!g) throw new QueryError('unknown group type'); extra = { group: g }; }
  const bf = q.breakdownFilter?.breakdown ? q.breakdownFilter : null;
  const personBd = bf && bf.breakdown_type === 'person';
  // Breakdown values are computed per row: clip the buckets to the range so the top-N count matches the old single-store SQL.
  const spec: TrendSpec = { buckets: bks.map(b => [b.start, b.end]), node: node(s), global: q.properties, breakdown: bf && !personBd ? String(bf.breakdown) : null,
    numKey: s.math_property ?? null, extra, values: !!PCT[math] };
  const shards = await en.shards(bks[0].start, bks[bks.length - 1].end - 1);
  const rows = await concat(shards.map(sh => sh.trend(spec)));
  const pf = [...personFilters(s.properties), ...personFilters(q.properties)];
  const needPeople = pf.length || personBd || math === 'dau';
  const P = needPeople ? people(en, rows.map(r => String(r[1]))) : null;
  type R = { bi: number; did: string; bv: string; c: number; sum: number; min: number | null; max: number | null; n: number; ex: unknown };
  let rs: R[] = [];
  for (const r of rows) {
    const did = String(r[1]);
    if (P && !P.ok(did, pf)) continue;
    const bv = personBd ? (textOf(P!.get(did).props[String(bf.breakdown)]) ?? NONE) : String(r[2]);
    if (spec.values) rs.push({ bi: Number(r[0]), did, bv, c: 1, sum: Number(r[3]), min: null, max: null, n: 1, ex: null });
    else rs.push({ bi: Number(r[0]), did, bv, c: Number(r[3]), sum: Number(r[4] ?? 0), min: r[5] == null ? null : Number(r[5]), max: r[6] == null ? null : Number(r[6]), n: Number(r[7]), ex: r[8] });
  }
  // Only events inside [from, to] count towards the top breakdown values.
  let breakdownValues: string[] | null = null;
  if (bf) {
    const limit = Math.min(Math.max(Number(bf.breakdown_limit) || 25, 1), 100);
    const tally = new Map<string, number>();
    for (const r of rs) tally.set(r.bv, (tally.get(r.bv) ?? 0) + r.c);
    const top = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(e => e[0]);
    breakdownValues = top.slice(0, limit);
    if (top.length > limit) { const keep = new Set(breakdownValues); rs = rs.map(r => keep.has(r.bv) ? r : { ...r, bv: OTHER }); breakdownValues.push(OTHER); }
  }
  const cells = new Map<string, R[]>();
  for (const r of rs) { const k = `${r.bi}\u0000${r.bv}`; let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(r); }
  const values = new Map<string, number[]>();
  const ensure = (bv: string) => { let a = values.get(bv); if (!a) { a = new Array(bks.length).fill(0); values.set(bv, a); } return a; };
  for (const [k, a] of cells) {
    const [bi, bv] = k.split('\u0000');
    let v = 0;
    switch (math) {
      case 'total': v = a.reduce((x, r) => x + r.c, 0); break;
      case 'dau': v = new Set(a.map(r => P!.get(r.did).pk)).size; break;
      case 'unique_session': case 'unique_group': v = new Set(a.filter(r => r.ex !== null && r.ex !== undefined).map(r => String(r.ex))).size; break;
      case 'sum': v = a.reduce((x, r) => x + r.sum, 0); break;
      case 'avg': { const n = a.reduce((x, r) => x + r.n, 0); v = n ? a.reduce((x, r) => x + r.sum, 0) / n : 0; break; }
      case 'min': { const m = a.filter(r => r.min !== null).map(r => r.min!); v = m.length ? Math.min(...m) : 0; break; }
      case 'max': { const m = a.filter(r => r.max !== null).map(r => r.max!); v = m.length ? Math.max(...m) : 0; break; }
      default: { const s2 = a.map(r => r.sum).sort((x, y) => x - y); v = percentile(s2, PCT[math]); }
    }
    ensure(bv)[Number(bi)] = v;
  }
  const keys = breakdownValues ?? [NONE];
  const name = s.custom_name || s.name || s.event || 'All events';
  return keys.map(bv => {
    const data = values.get(bv) ?? new Array(bks.length).fill(0);
    const count = data.reduce((a, b) => a + b, 0);
    return {
      label: bf ? `${name} - ${breakdownLabel(bv)}` : name,
      action: { id: s.event ?? null, name, custom_name: s.custom_name ?? null, order, math, math_property: s.math_property ?? null },
      breakdown_value: bf ? bv : undefined,
      breakdown_label: bf ? breakdownLabel(bv) : undefined,
      data, labels: bks.map(b => b.label), days: bks.map(b => new Date(b.start).toISOString()),
      count: Math.round(count * 1000) / 1000,
      aggregated_value: aggregated ? data[0] : undefined,
      compare_label: compareLabel,
    };
  }).filter(r => !bf || r.count > 0 || keys.length === 1);
}

// ---------------- Funnels ----------------
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3600_000, day: 86400_000, week: 7 * 86400_000, month: 31 * 86400_000 };
export type FEv = { ts: number; m: number[]; bv: string; v?: number | null };

/** Per-person step events for a funnel, merged across shards and distinct ids, in time order. */
export async function funnelPeople(en: Engine, steps: EventsNode[], global: PropertyFilter[] | undefined, from: number, to: number, bf: any, value?: string | null): Promise<{ byPerson: Map<string, FEv[]>; P: ReturnType<typeof people> }> {
  const personBd = bf && bf.breakdown_type === 'person';
  const spec: FunnelSpec = { from, to, steps: steps.map(node), global, breakdown: bf && !personBd ? String(bf.breakdown) : null, value: value ?? null };
  const rows = await concat((await en.shards(from, to)).map(sh => sh.funnel(spec)));
  const gpf = personFilters(global); const spf = steps.map(s => personFilters(s.properties));
  const P = people(en, rows.map(r => String(r[0])));
  const byPerson = new Map<string, FEv[]>();
  for (const r of rows) {
    const did = String(r[0]);
    if (!P.ok(did, gpf)) continue;
    const mask = Number(r[2]);
    const m = steps.map((_, k) => (mask & (2 ** k)) && P.ok(did, spf[k]) ? 1 : 0);
    if (!m.some(Boolean)) continue;
    const ref = P.get(did);
    const bv = personBd ? (textOf(ref.props[String(bf.breakdown)]) ?? NONE) : String(r[3]);
    let a = byPerson.get(ref.pk); if (!a) byPerson.set(ref.pk, a = []);
    a.push({ ts: Number(r[1]), m, bv, v: r[4] === null || r[4] === undefined ? null : Number(r[4]) });
  }
  for (const a of byPerson.values()) a.sort((x, y) => x.ts - y.ts);
  return { byPerson, P };
}

/** Best path for one person's events (ordered as PostHog's funnel UDF, or unordered). */
export function personFunnel(evs: FEv[], n: number, windowMs: number, unordered: boolean, range: { from: number; to: number }) {
  if (!unordered) return orderedPass(evs.filter(e => e.ts >= range.from && e.ts <= range.to), n, windowMs);
  let best: { reached: number; times: number[]; bv: string } | null = null;
  for (let i = 0; i < evs.length; i++) {
    const start = evs[i];
    if (start.ts < range.from || start.ts > range.to || !start.m.some(Boolean)) continue;
    const done = new Map<number, number>();
    for (let j = i; j < evs.length && evs[j].ts <= start.ts + windowMs; j++) evs[j].m.forEach((v, k) => { if (v && !done.has(k)) done.set(k, evs[j].ts); });
    const cand = { reached: done.size, times: [...done.values()].sort((a, b) => a - b), bv: start.bv };
    if (!best || cand.reached > best.reached) best = cand;
    if (best.reached === n) break;
  }
  return best;
}

async function funnels(en: Engine, q: any, qc: QueryContext) {
  const tz = qc.timezone, now = qc.now ?? Date.now();
  const steps: EventsNode[] = Array.isArray(q.series) ? q.series : [];
  if (steps.length < 2) throw new QueryError('a funnel needs at least 2 steps');
  if (steps.length > 20) throw new QueryError('at most 20 steps');
  const range = resolveRange(q.dateRange?.date_from, q.dateRange?.date_to, tz, now, q.dateRange?.date_from === 'all' ? await en.firstEventAt() : null);
  const ff = q.funnelsFilter ?? {};
  const windowMs = Math.max(1, Number(ff.funnelWindowInterval) || 14) * (UNIT_MS[ff.funnelWindowIntervalUnit ?? 'day'] ?? UNIT_MS.day);
  const unordered = ff.funnelOrderType === 'unordered';
  const bf = q.breakdownFilter?.breakdown ? q.breakdownFilter : null;
  const n = steps.length;
  const { byPerson } = await funnelPeople(en, steps, q.properties, range.from, range.to, bf);
  const perBreakdown = new Map<string, { counts: number[]; conv: number[][] }>();
  for (const pk of [...byPerson.keys()].sort()) { // sorted so float sums do not depend on shard layout
    const b = personFunnel(byPerson.get(pk)!, n, windowMs, unordered, range);
    if (!b || b.reached <= 0) continue;
    let agg = perBreakdown.get(b.bv); if (!agg) perBreakdown.set(b.bv, agg = { counts: new Array(n).fill(0), conv: Array.from({ length: n }, () => []) });
    for (let k = 0; k < b.reached; k++) { agg.counts[k]++; if (k > 0) agg.conv[k].push((b.times[k] - b.times[k - 1]) / 1000); }
  }
  const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return percentile(s, 0.5); };
  const build = (bv: string) => {
    const agg = perBreakdown.get(bv) ?? { counts: new Array(n).fill(0), conv: Array.from({ length: n }, () => []) };
    return steps.map((s, k) => ({
      action_id: s.event ?? null, name: unordered ? `Completed ${k + 1} step${k ? 's' : ''}` : s.event ?? 'All events', custom_name: s.custom_name ?? null, order: k,
      count: agg.counts[k],
      average_conversion_time: k && agg.conv[k].length ? agg.conv[k].reduce((a, b) => a + b, 0) / agg.conv[k].length : null,
      median_conversion_time: k ? median(agg.conv[k]) : null,
      breakdown_value: bf ? bv : undefined, breakdown_label: bf ? breakdownLabel(bv) : undefined,
    }));
  };
  const dates = { date_from: new Date(range.from).toISOString(), date_to: new Date(range.to).toISOString() };
  if (!bf) return { kind: 'FunnelsQuery', results: build(NONE), ...dates };
  const limit = Math.min(Math.max(Number(bf.breakdown_limit) || 25, 1), 100);
  const keys = [...perBreakdown.entries()].sort((a, b) => b[1].counts[0] - a[1].counts[0]).slice(0, limit).map(e => e[0]);
  return { kind: 'FunnelsQuery', results: keys.map(build), ...dates };
}

/**
 * One person's ordered funnel, as PostHog's funnel UDF (funnel-udf/src/steps.rs): events in time order; a step-1 event
 * starts a new chain (replacing the previous one); a step-k event extends the chain that reached step k-1 when it is within
 * the window of that chain's first event. The result is the first chain to reach the furthest step, with its step times.
 */
function orderedPass(evs: FEv[], n: number, windowMs: number) {
  type Chain = { start: number; times: number[]; bv: string };
  const entered: (Chain | null)[] = new Array(n).fill(null);
  let max: Chain | null = null;
  for (const ev of evs) {
    for (let k = n - 1; k >= 0; k--) {
      if (!ev.m[k]) continue;
      if (k === 0) { entered[0] = { start: ev.ts, times: [ev.ts], bv: ev.bv }; if (!max) max = entered[0]; continue; }
      const prev = entered[k - 1];
      if (!prev || ev.ts - prev.start > windowMs) continue;
      if (entered[k] && entered[k]!.start === prev.start) continue; // this chain already reached step k
      entered[k] = { start: prev.start, times: [...prev.times, ev.ts], bv: prev.bv };
      if (!max || k + 1 > max.times.length) max = entered[k];
    }
    if (entered[n - 1]) break;
  }
  return max ? { reached: max.times.length, times: max.times, bv: max.bv } : null;
}

// ---------------- Retention ----------------
async function retention(en: Engine, q: any, qc: QueryContext) {
  const tz = qc.timezone, now = qc.now ?? Date.now();
  const rf = q.retentionFilter ?? {};
  const unit: Interval = ({ Hour: 'hour', Day: 'day', Week: 'week', Month: 'month' } as Record<string, Interval>)[rf.period ?? 'Day'] ?? 'day';
  const total = Math.min(Math.max(Number(rf.totalIntervals) || 8, 1), 60);
  const end = q.dateRange?.date_to ? resolveRange(q.dateRange.date_to, q.dateRange.date_to, tz, now).to : now;
  const last = startOf(end, unit, tz);
  const first = unit === 'hour' ? last - (total - 1) * 3600_000 : addInterval(last, unit, -(total - 1), tz);
  const bks = buckets({ from: first, to: last }, unit, tz).slice(0, total);
  const endMs = bks[bks.length - 1].end;
  validateFilters(rf.targetEntity?.properties); validateFilters(rf.returningEntity?.properties);
  const target: EventsNode = { event: rf.targetEntity?.id ?? '$pageview', properties: rf.targetEntity?.properties };
  const returning: EventsNode = { event: rf.returningEntity?.id ?? target.event, properties: rf.returningEntity?.properties };
  const shards = await en.shards(first, endMs - 1);
  const bspec = bks.map(b => [b.start, b.end] as [number, number]);
  const periods = async (n: EventsNode) => {
    const rows = await concat(shards.map(sh => sh.periods({ buckets: bspec, node: node(n), global: q.properties })));
    const pf = [...personFilters(n.properties), ...personFilters(q.properties)];
    const P = people(en, rows.map(r => String(r[0])));
    const m = new Map<string, Set<number>>();
    for (const r of rows) { const d = String(r[0]); if (!P.ok(d, pf)) continue; const k = P.get(d).pk; let s = m.get(k); if (!s) m.set(k, s = new Set()); s.add(Number(r[1])); }
    return m;
  };
  const cohorts: Set<string>[] = bks.map(() => new Set());
  if (rf.retentionType === 'retention_first_time') {
    const all = await en.shards(-8.64e15, endMs - 1);
    const rows = await concat(all.map(sh => sh.firsts({ node: node(target), global: q.properties, before: endMs })));
    const pf = [...personFilters(target.properties), ...personFilters(q.properties)];
    const P = people(en, rows.map(r => String(r[0])));
    const firsts = new Map<string, number>();
    for (const r of rows) { const d = String(r[0]); if (!P.ok(d, pf)) continue; const k = P.get(d).pk; const t = Number(r[1]); if (!firsts.has(k) || t < firsts.get(k)!) firsts.set(k, t); }
    for (const [pk, f] of firsts) { if (f < first || f >= endMs) continue; const i = bks.findIndex(b => f >= b.start && f < b.end); if (i >= 0) cohorts[i].add(pk); }
  } else {
    for (const [pk, s] of await periods(target)) for (const i of s) cohorts[i].add(pk);
  }
  const ret = await periods(returning);
  const name = unit[0].toUpperCase() + unit.slice(1);
  const results = bks.map((b, i) => {
    const values: { count: number }[] = [];
    for (let k = 0; i + k < bks.length; k++) {
      if (k === 0) { values.push({ count: cohorts[i].size }); continue; }
      let c = 0; for (const pk of cohorts[i]) if (ret.get(pk)?.has(i + k)) c++;
      values.push({ count: c });
    }
    return { date: new Date(b.start).toISOString(), label: `${name} ${i}`, cohort_label: b.label, values };
  });
  return { kind: 'RetentionQuery', results, period: rf.period ?? 'Day' };
}

// ---------------- Events ----------------
/** Newest first across shards (k-way merge on (timestamp, uuid)); the cursor is `<timestamp>_<uuid>`. */
async function eventsQuery(en: Engine, q: any) {
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000);
  const pf = personFilters(q.properties);
  let distinctIds: string[] | null = null;
  if (q.personId) distinctIds = en.distinctIdsOfPerson(String(q.personId));
  if (q.distinctId) distinctIds = distinctIds ? distinctIds.filter(d => d === String(q.distinctId)) : [String(q.distinctId)];
  if (distinctIds && !distinctIds.length) return { kind: 'EventsQuery', hasMore: false, next: null, results: [] };
  const after = q.after ? Date.parse(q.after) : NaN, before = q.before ? Date.parse(q.before) : NaN;
  let cursor: [number, string] | null = null;
  if (q.cursor) { const s = String(q.cursor); const i = s.indexOf('_'); const t = Number(s.slice(0, i)); if (i > 0 && Number.isFinite(t)) cursor = [t, s.slice(i + 1)]; }
  const lo = Number.isFinite(after) ? after : -8.64e15, hi = Math.min(Number.isFinite(before) ? before - 1 : 8.64e15, cursor ? cursor[0] : 8.64e15);
  const shards = await en.shards(lo, hi);
  const out: EventRow[] = [];
  let more = false;
  for (let round = 0; round < 20; round++) {
    const want = limit - out.length + 1;
    const spec: EventsSpec = { event: q.event || null, properties: q.properties, distinctIds, after: Number.isFinite(after) ? after : null, before: Number.isFinite(before) ? before : null, cursor, limit: want };
    const rows = (await concat(shards.map(sh => sh.events(spec)))).sort((a, b) => b.timestamp - a.timestamp || (a.uuid < b.uuid ? 1 : a.uuid > b.uuid ? -1 : 0)).slice(0, want);
    const exhausted = rows.length < want;
    const P = pf.length ? people(en, rows.map(r => r.distinct_id)) : null;
    for (const r of rows) { if (!P || P.ok(r.distinct_id, pf)) out.push(r); }
    if (rows.length) cursor = [rows[rows.length - 1].timestamp, rows[rows.length - 1].uuid];
    if (out.length > limit) { more = true; break; }
    if (exhausted) break;
  }
  const page = out.slice(0, limit);
  const P = people(en, page.map(r => r.distinct_id));
  return {
    kind: 'EventsQuery', hasMore: more,
    next: more ? `${page[page.length - 1].timestamp}_${page[page.length - 1].uuid}` : null,
    results: page.map(r => {
      const ref = P.get(r.distinct_id);
      return { uuid: r.uuid, event: r.event, distinct_id: r.distinct_id, timestamp: new Date(Number(r.timestamp)).toISOString(), properties: JSON.parse(String(r.properties)),
        person: ref.uuid ? { id: ref.uuid, name: (ref.props.email ?? ref.props.name ?? r.distinct_id) as string } : null };
    }),
  };
}
