// Insight queries run inside a ProjectStore (design.md "Queries"). All SQL is SQLite, all times are ms UTC.
import { buckets, resolveRange, startOf, addInterval, label as bucketLabel, Interval } from '../shared/dates';

export type QueryContext = { timezone: string; now?: number };
export type PropertyFilter = { key: string; value?: unknown; operator?: string; type?: 'event' | 'person' };
export type EventsNode = { kind?: 'EventsNode'; event?: string | null; name?: string; custom_name?: string; math?: string; math_property?: string; math_group_type_index?: number; properties?: PropertyFilter[] };
export class QueryError extends Error { constructor(msg: string) { super(msg); } }

const PERSON_KEY = `COALESCE('p' || d.person_id, 'd' || e.distinct_id)`;
const JOINS = `LEFT JOIN person_distinct_ids d ON d.distinct_id = e.distinct_id LEFT JOIN persons p ON p.id = d.person_id`;
const NONE = '$$_none_$$', OTHER = '$$_other_$$';
const AGG_DISPLAYS = new Set(['BoldNumber', 'ActionsTable', 'ActionsPie', 'ActionsBarValue']);
const MATHS = new Set(['total', 'dau', 'unique_session', 'unique_group', 'sum', 'avg', 'min', 'max', 'median', 'p75', 'p90', 'p95', 'p99']);

type Sql = { sql: string; params: SqlStorageValue[] };
const pathOf = (key: string) => { if (typeof key !== 'string' || !key || key.length > 400) throw new QueryError('bad property key'); return '$.' + JSON.stringify(key); };
const col = (type: string | undefined) => type === 'person' ? 'p.properties' : 'e.properties';
/** Text form of a JSON property: booleans as true/false, numbers as SQLite prints them, null when missing. */
function textExpr(src: string, key: string): Sql {
  const p = pathOf(key);
  return { sql: `(CASE json_type(${src}, ?) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'object' THEN json_extract(${src}, ?) WHEN 'array' THEN json_extract(${src}, ?) ELSE CAST(json_extract(${src}, ?) AS TEXT) END)`, params: [p, p, p, p] };
}
function propertySql(f: PropertyFilter): Sql {
  const src = col(f.type); const t = textExpr(src, f.key); const op = f.operator ?? 'exact';
  const vals = (Array.isArray(f.value) ? f.value : [f.value]).filter(v => v !== undefined && v !== null).map(v => typeof v === 'string' ? v : JSON.stringify(v));
  const inList = `(SELECT value FROM json_each(?))`;
  switch (op) {
    case 'exact': return { sql: `${t.sql} IN ${inList}`, params: [...t.params, JSON.stringify(vals)] };
    case 'is_not': return { sql: `(${t.sql} IS NULL OR ${t.sql} NOT IN ${inList})`, params: [...t.params, ...t.params, JSON.stringify(vals)] };
    case 'icontains': return { sql: `instr(lower(${t.sql}), lower(?)) > 0`, params: [...t.params, String(vals[0] ?? '')] };
    case 'not_icontains': return { sql: `(${t.sql} IS NULL OR instr(lower(${t.sql}), lower(?)) = 0)`, params: [...t.params, ...t.params, String(vals[0] ?? '')] };
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      return { sql: `CAST(json_extract(${src}, ?) AS REAL) ${sym} ?`, params: [pathOf(f.key), Number(vals[0])] };
    }
    case 'is_set': return { sql: `json_type(${src}, ?) IS NOT NULL AND json_type(${src}, ?) != 'null'`, params: [pathOf(f.key), pathOf(f.key)] };
    case 'is_not_set': return { sql: `(json_type(${src}, ?) IS NULL OR json_type(${src}, ?) = 'null')`, params: [pathOf(f.key), pathOf(f.key)] };
    case 'is_date_before': case 'is_date_after': {
      const t2 = Date.parse(String(vals[0])); if (!Number.isFinite(t2)) throw new QueryError('bad date value');
      return { sql: `julianday(json_extract(${src}, ?)) ${op === 'is_date_before' ? '<' : '>'} julianday(?)`, params: [pathOf(f.key), new Date(t2).toISOString()] };
    }
    default: throw new QueryError(`unsupported operator ${op}`);
  }
}
function filtersSql(fs: PropertyFilter[] | undefined): Sql {
  const parts = (fs ?? []).filter(f => f && f.key).map(propertySql);
  if (!parts.length) return { sql: '1', params: [] };
  return { sql: parts.map(p => `(${p.sql})`).join(' AND '), params: parts.flatMap(p => p.params) };
}
function nodeSql(n: EventsNode): Sql {
  const f = filtersSql(n.properties);
  if (n.event === null || n.event === undefined || n.event === '') return f;
  return { sql: `e.event = ? AND ${f.sql}`, params: [n.event, ...f.params] };
}
const and = (...s: Sql[]): Sql => ({ sql: s.map(x => `(${x.sql})`).join(' AND '), params: s.flatMap(x => x.params) });
function breakdownExpr(bf: any): Sql | null {
  if (!bf?.breakdown) return null;
  const t = textExpr(col(bf.breakdown_type === 'person' ? 'person' : 'event'), String(bf.breakdown));
  return { sql: `COALESCE(${t.sql}, '${NONE}')`, params: t.params };
}
const bucketCte = (bs: { start: number; end: number }[]): Sql => ({ sql: `b(i, s, en) AS (SELECT CAST(key AS INTEGER), json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`, params: [JSON.stringify(bs.map(b => [b.start, b.end]))] });
const breakdownLabel = (v: string) => v === NONE ? 'None' : v === OTHER ? 'Other' : v;

function percentile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function runQuery(sql: SqlStorage, q: any, qc: QueryContext): unknown {
  if (!q || typeof q !== 'object') throw new QueryError('query must be an object');
  switch (q.kind) {
    case 'TrendsQuery': return trends(sql, q, qc);
    case 'FunnelsQuery': return funnels(sql, q, qc);
    case 'RetentionQuery': return retention(sql, q, qc);
    case 'EventsQuery': return eventsQuery(sql, q);
    default: throw new QueryError(`unsupported query kind ${q.kind}`);
  }
}

function firstEvent(sql: SqlStorage): number | null { return (sql.exec('SELECT MIN(timestamp) AS m FROM events').one().m as number | null) ?? null; }

// ---------------- Trends ----------------
function trends(sql: SqlStorage, q: any, qc: QueryContext) {
  const tz = qc.timezone, now = qc.now ?? Date.now();
  const series: EventsNode[] = Array.isArray(q.series) && q.series.length ? q.series : [{ event: '$pageview' }];
  if (series.length > 20) throw new QueryError('at most 20 series');
  const interval: Interval = ['hour', 'day', 'week', 'month'].includes(q.interval) ? q.interval : 'day';
  const range = resolveRange(q.dateRange?.date_from, q.dateRange?.date_to, tz, now, q.dateRange?.date_from === 'all' ? firstEvent(sql) : null);
  const display = q.trendsFilter?.display ?? 'ActionsLineGraph';
  const aggregated = AGG_DISPLAYS.has(display);
  const run = (r: { from: number; to: number }, compareLabel?: string) => {
    const bks = aggregated ? [{ start: r.from, end: r.to + 1, label: `${bucketLabel(r.from, 'day', tz)} - ${bucketLabel(r.to, 'day', tz)}` }] : buckets(r, interval, tz);
    if (bks.length > 2000) throw new QueryError('too many intervals; pick a larger interval');
    const out: any[] = [];
    series.forEach((s, i) => out.push(...trendSeries(sql, q, s, i, bks, r, aggregated, compareLabel)));
    return out;
  };
  let results = run(range, q.compareFilter?.compare ? 'current' : undefined);
  if (q.compareFilter?.compare) {
    const len = range.to - range.from;
    const prev = { from: range.from - len - 1, to: range.from - 1 };
    const pres = run(prev, 'previous');
    // Previous-period series use the current period's labels, aligned by index.
    for (const p of pres) { const cur = results.find(r => r.action.order === p.action.order && r.breakdown_value === p.breakdown_value); if (cur) { p.labels = cur.labels; p.days = cur.days; } }
    results = [...results, ...pres];
  }
  return { kind: 'TrendsQuery', results, timezone: tz, interval, date_from: new Date(range.from).toISOString(), date_to: new Date(range.to).toISOString() };
}

function trendSeries(sql: SqlStorage, q: any, s: EventsNode, order: number, bks: { start: number; end: number; label: string }[], range: { from: number; to: number }, aggregated: boolean, compareLabel?: string) {
  const math = s.math ?? 'total';
  if (!MATHS.has(math)) throw new QueryError(`unsupported math ${math}`);
  const where = and(nodeSql(s), filtersSql(q.properties));
  const bd = breakdownExpr(q.breakdownFilter);
  let bdSql: Sql = { sql: `'${NONE}'`, params: [] };
  let breakdownValues: string[] | null = null;
  if (bd) {
    const limit = Math.min(Math.max(Number(q.breakdownFilter.breakdown_limit) || 25, 1), 100);
    const top = sql.exec(`SELECT ${bd.sql} AS bv, COUNT(*) AS c FROM events e ${JOINS} WHERE e.timestamp >= ? AND e.timestamp <= ? AND ${where.sql} GROUP BY bv ORDER BY c DESC LIMIT ?`,
      ...bd.params, range.from, range.to, ...where.params, limit + 1).toArray().map(r => String(r.bv));
    breakdownValues = top.slice(0, limit);
    const hasOther = top.length > limit;
    bdSql = hasOther ? { sql: `(CASE WHEN ${bd.sql} IN (SELECT value FROM json_each(?)) THEN ${bd.sql} ELSE '${OTHER}' END)`, params: [...bd.params, JSON.stringify(breakdownValues), ...bd.params] } : bd;
    if (hasOther) breakdownValues.push(OTHER);
  }
  const prop = s.math_property ? textExpr('e.properties', s.math_property) : null;
  const numExpr = s.math_property ? { sql: `CAST(json_extract(e.properties, ?) AS REAL)`, params: [pathOf(s.math_property)] } : null;
  if (['sum', 'avg', 'min', 'max', 'median', 'p75', 'p90', 'p95', 'p99'].includes(math) && !numExpr) throw new QueryError(`math ${math} needs math_property`);
  let agg: Sql;
  const groupType = (): string => {
    const gt = sql.exec('SELECT name FROM group_types WHERE idx = ?', Number(s.math_group_type_index ?? 0)).toArray()[0]?.name as string | undefined;
    if (!gt) throw new QueryError('unknown group type'); return gt;
  };
  switch (math) {
    case 'total': agg = { sql: 'COUNT(*)', params: [] }; break;
    case 'dau': agg = { sql: `COUNT(DISTINCT ${PERSON_KEY})`, params: [] }; break;
    case 'unique_session': agg = { sql: `COUNT(DISTINCT json_extract(e.properties, '$."$session_id"'))`, params: [] }; break;
    case 'unique_group': agg = { sql: `COUNT(DISTINCT json_extract(e.properties, ?))`, params: ['$."$groups".' + JSON.stringify(groupType())] }; break;
    case 'sum': agg = { sql: `COALESCE(SUM(${numExpr!.sql}), 0)`, params: numExpr!.params }; break;
    case 'avg': agg = { sql: `COALESCE(AVG(${numExpr!.sql}), 0)`, params: numExpr!.params }; break;
    case 'min': agg = { sql: `COALESCE(MIN(${numExpr!.sql}), 0)`, params: numExpr!.params }; break;
    case 'max': agg = { sql: `COALESCE(MAX(${numExpr!.sql}), 0)`, params: numExpr!.params }; break;
    default: agg = { sql: 'NULL', params: [] };
  }
  void prop;
  const cte = bucketCte(bks);
  const values = new Map<string, number[]>();
  const ensure = (bv: string) => { let a = values.get(bv); if (!a) { a = new Array(bks.length).fill(0); values.set(bv, a); } return a; };
  if (['median', 'p75', 'p90', 'p95', 'p99'].includes(math)) {
    const qv = { median: 0.5, p75: 0.75, p90: 0.9, p95: 0.95, p99: 0.99 }[math as 'median']!;
    const groups = new Map<string, number[]>();
    for (const r of sql.exec(`WITH ${cte.sql} SELECT b.i AS bi, ${bdSql.sql} AS bv, ${numExpr!.sql} AS v FROM b JOIN events e ON e.timestamp >= b.s AND e.timestamp < b.en ${JOINS} WHERE ${where.sql} AND ${numExpr!.sql} IS NOT NULL`,
      ...cte.params, ...bdSql.params, ...numExpr!.params, ...where.params, ...numExpr!.params)) {
      const k = `${r.bi}\u0000${r.bv}`; let a = groups.get(k); if (!a) groups.set(k, a = []); a.push(Number(r.v));
    }
    for (const [k, a] of groups) { const [bi, bv] = k.split('\u0000'); a.sort((x, y) => x - y); ensure(bv)[Number(bi)] = percentile(a, qv); }
  } else {
    for (const r of sql.exec(`WITH ${cte.sql} SELECT b.i AS bi, ${bdSql.sql} AS bv, ${agg.sql} AS v FROM b JOIN events e ON e.timestamp >= b.s AND e.timestamp < b.en ${JOINS} WHERE ${where.sql} GROUP BY bi, bv`,
      ...cte.params, ...bdSql.params, ...agg.params, ...where.params)) ensure(String(r.bv))[Number(r.bi)] = Number(r.v) || 0;
  }
  const keys = breakdownValues ?? [NONE];
  const name = s.custom_name || s.name || s.event || 'All events';
  return keys.map(bv => {
    const data = values.get(bv) ?? new Array(bks.length).fill(0);
    const count = data.reduce((a, b) => a + b, 0);
    return {
      label: bd ? `${name} - ${breakdownLabel(bv)}` : name,
      action: { id: s.event ?? null, name, custom_name: s.custom_name ?? null, order, math, math_property: s.math_property ?? null },
      breakdown_value: bd ? bv : undefined,
      breakdown_label: bd ? breakdownLabel(bv) : undefined,
      data, labels: bks.map(b => b.label), days: bks.map(b => new Date(b.start).toISOString()),
      count: Math.round(count * 1000) / 1000,
      aggregated_value: aggregated ? data[0] : undefined,
      compare_label: compareLabel,
    };
  }).filter(r => !bd || r.count > 0 || keys.length === 1);
}

// ---------------- Funnels ----------------
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3600_000, day: 86400_000, week: 7 * 86400_000, month: 31 * 86400_000 };

function funnels(sql: SqlStorage, q: any, qc: QueryContext) {
  const tz = qc.timezone, now = qc.now ?? Date.now();
  const steps: EventsNode[] = Array.isArray(q.series) ? q.series : [];
  if (steps.length < 2) throw new QueryError('a funnel needs at least 2 steps');
  if (steps.length > 20) throw new QueryError('at most 20 steps');
  const range = resolveRange(q.dateRange?.date_from, q.dateRange?.date_to, tz, now, q.dateRange?.date_from === 'all' ? firstEvent(sql) : null);
  const ff = q.funnelsFilter ?? {};
  const windowMs = Math.max(1, Number(ff.funnelWindowInterval) || 14) * (UNIT_MS[ff.funnelWindowIntervalUnit ?? 'day'] ?? UNIT_MS.day);
  const unordered = ff.funnelOrderType === 'unordered';
  const conds = steps.map(nodeSql);
  const global = filtersSql(q.properties);
  const bd = breakdownExpr(q.breakdownFilter);
  const sel = conds.map((c, k) => ({ sql: `(CASE WHEN ${c.sql} THEN 1 ELSE 0 END) AS s${k}`, params: c.params }));
  const any = { sql: conds.map(c => `(${c.sql})`).join(' OR '), params: conds.flatMap(c => c.params) };
  const n = steps.length;
  type Best = { reached: number; times: number[]; bv: string };
  const perBreakdown = new Map<string, { counts: number[]; conv: number[][] }>();
  const record = (b: Best) => {
    let agg = perBreakdown.get(b.bv); if (!agg) perBreakdown.set(b.bv, agg = { counts: new Array(n).fill(0), conv: Array.from({ length: n }, () => []) });
    for (let k = 0; k < b.reached; k++) { agg.counts[k]++; if (k > 0) agg.conv[k].push((b.times[k] - b.times[k - 1]) / 1000); }
  };
  let curKey: string | null = null; let evs: { ts: number; m: number[]; bv: string }[] = [];
  const flush = () => {
    if (!evs.length) return;
    let best: Best | null = null;
    for (let i = 0; i < evs.length; i++) {
      const start = evs[i];
      if (start.ts < range.from || start.ts > range.to) continue;
      if (unordered) {
        if (!start.m.some(Boolean)) continue;
        const done = new Map<number, number>();
        for (let j = i; j < evs.length && evs[j].ts <= start.ts + windowMs; j++) evs[j].m.forEach((v, k) => { if (v && !done.has(k)) done.set(k, evs[j].ts); });
        const times = [...done.values()].sort((a, b) => a - b);
        const cand = { reached: done.size, times, bv: start.bv };
        if (!best || cand.reached > best.reached) best = cand;
      } else break; // ordered funnels are handled below in one pass
      if (best && best.reached === n) break;
    }
    if (!unordered) best = orderedPass(evs, n, windowMs);
    if (best && best.reached > 0) record(best);
    evs = [];
  };
  const params = [...sel.flatMap(s => s.params), ...(bd?.params ?? []), range.from, range.to, ...any.params, ...global.params];
  const cur = sql.exec(`SELECT ${PERSON_KEY} AS pk, e.timestamp AS ts, ${sel.map(s => s.sql).join(', ')}, ${bd ? bd.sql : `'${NONE}'`} AS bv
      FROM events e ${JOINS} WHERE e.timestamp >= ? AND e.timestamp <= ? AND (${any.sql}) AND ${global.sql} ORDER BY pk, e.timestamp`, ...params);
  for (const r of cur) {
    const key = String(r.pk);
    if (key !== curKey) { flush(); curKey = key; }
    evs.push({ ts: Number(r.ts), m: steps.map((_, k) => Number(r['s' + k])), bv: String(r.bv) });
  }
  flush();
  const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return percentile(s, 0.5); };
  const build = (bv: string) => {
    const agg = perBreakdown.get(bv) ?? { counts: new Array(n).fill(0), conv: Array.from({ length: n }, () => []) };
    return steps.map((s, k) => ({
      action_id: s.event ?? null, name: unordered ? `Completed ${k + 1} step${k ? 's' : ''}` : s.event ?? 'All events', custom_name: s.custom_name ?? null, order: k,
      count: agg.counts[k],
      average_conversion_time: k && agg.conv[k].length ? agg.conv[k].reduce((a, b) => a + b, 0) / agg.conv[k].length : null,
      median_conversion_time: k ? median(agg.conv[k]) : null,
      breakdown_value: bd ? bv : undefined, breakdown_label: bd ? breakdownLabel(bv) : undefined,
    }));
  };
  if (!bd) return { kind: 'FunnelsQuery', results: build(NONE), date_from: new Date(range.from).toISOString(), date_to: new Date(range.to).toISOString() };
  const limit = Math.min(Math.max(Number(q.breakdownFilter.breakdown_limit) || 25, 1), 100);
  const keys = [...perBreakdown.entries()].sort((a, b) => b[1].counts[0] - a[1].counts[0]).slice(0, limit).map(e => e[0]);
  return { kind: 'FunnelsQuery', results: keys.map(build), date_from: new Date(range.from).toISOString(), date_to: new Date(range.to).toISOString() };
}

/**
 * One person's ordered funnel, as PostHog's funnel UDF (funnel-udf/src/steps.rs): events in time order; a step-1 event
 * starts a new chain (replacing the previous one); a step-k event extends the chain that reached step k-1 when it is within
 * the window of that chain's first event. The result is the first chain to reach the furthest step, with its step times.
 */
function orderedPass(evs: { ts: number; m: number[]; bv: string }[], n: number, windowMs: number) {
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
function retention(sql: SqlStorage, q: any, qc: QueryContext) {
  const tz = qc.timezone, now = qc.now ?? Date.now();
  const rf = q.retentionFilter ?? {};
  const unit: Interval = ({ Hour: 'hour', Day: 'day', Week: 'week', Month: 'month' } as Record<string, Interval>)[rf.period ?? 'Day'] ?? 'day';
  const total = Math.min(Math.max(Number(rf.totalIntervals) || 8, 1), 60);
  const end = q.dateRange?.date_to ? resolveRange(q.dateRange.date_to, q.dateRange.date_to, tz, now).to : now;
  const last = startOf(end, unit, tz);
  const first = unit === 'hour' ? last - (total - 1) * 3600_000 : addInterval(last, unit, -(total - 1), tz);
  const bks = buckets({ from: first, to: last }, unit, tz).slice(0, total);
  const endMs = bks[bks.length - 1].end;
  const target: EventsNode = { event: rf.targetEntity?.id ?? '$pageview', properties: rf.targetEntity?.properties };
  const returning: EventsNode = { event: rf.returningEntity?.id ?? target.event, properties: rf.returningEntity?.properties };
  const global = filtersSql(q.properties);
  const cte = bucketCte(bks);
  const periods = (node: EventsNode) => {
    const c = and(nodeSql(node), global);
    const m = new Map<string, Set<number>>();
    for (const r of sql.exec(`WITH ${cte.sql} SELECT DISTINCT ${PERSON_KEY} AS pk, b.i AS bi FROM b JOIN events e ON e.timestamp >= b.s AND e.timestamp < b.en ${JOINS} WHERE ${c.sql}`, ...cte.params, ...c.params)) {
      const k = String(r.pk); let s = m.get(k); if (!s) m.set(k, s = new Set()); s.add(Number(r.bi));
    }
    return m;
  };
  const cohorts: Set<string>[] = bks.map(() => new Set());
  if (rf.retentionType === 'retention_first_time') {
    const c = and(nodeSql(target), global);
    const firsts = sql.exec(`SELECT ${PERSON_KEY} AS pk, MIN(e.timestamp) AS f FROM events e ${JOINS} WHERE ${c.sql} GROUP BY pk HAVING f >= ? AND f < ?`, ...c.params, first, endMs);
    for (const r of firsts) { const f = Number(r.f); const i = bks.findIndex(b => f >= b.start && f < b.end); if (i >= 0) cohorts[i].add(String(r.pk)); }
  } else {
    for (const [pk, s] of periods(target)) for (const i of s) cohorts[i].add(pk);
  }
  const ret = periods(returning);
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
function eventsQuery(sql: SqlStorage, q: any) {
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000);
  const parts: Sql[] = [filtersSql(q.properties)];
  if (q.event) parts.push({ sql: 'e.event = ?', params: [String(q.event)] });
  if (q.personId) parts.push({ sql: 'e.distinct_id IN (SELECT distinct_id FROM person_distinct_ids WHERE person_id = (SELECT id FROM persons WHERE uuid = ?))', params: [String(q.personId)] });
  if (q.distinctId) parts.push({ sql: 'e.distinct_id = ?', params: [String(q.distinctId)] });
  if (q.after) { const t = Date.parse(q.after); if (Number.isFinite(t)) parts.push({ sql: 'e.timestamp >= ?', params: [t] }); }
  if (q.before) { const t = Date.parse(q.before); if (Number.isFinite(t)) parts.push({ sql: 'e.timestamp < ?', params: [t] }); }
  if (q.cursor) { const [t, id] = String(q.cursor).split('_').map(Number); parts.push({ sql: '(e.timestamp < ? OR (e.timestamp = ? AND e.id < ?))', params: [t, t, id] }); }
  const w = and(...parts);
  const rows = sql.exec(`SELECT e.id, e.uuid, e.event, e.distinct_id, e.timestamp, e.properties, p.uuid AS person_uuid, p.properties AS person_properties
      FROM events e ${JOINS} WHERE ${w.sql} ORDER BY e.timestamp DESC, e.id DESC LIMIT ?`, ...w.params, limit + 1).toArray();
  const more = rows.length > limit; const page = rows.slice(0, limit);
  return {
    kind: 'EventsQuery', hasMore: more,
    next: more ? `${page[page.length - 1].timestamp}_${page[page.length - 1].id}` : null,
    results: page.map(r => {
      const pp = r.person_properties ? JSON.parse(String(r.person_properties)) : null;
      return { uuid: r.uuid, event: r.event, distinct_id: r.distinct_id, timestamp: new Date(Number(r.timestamp)).toISOString(), properties: JSON.parse(String(r.properties)),
        person: r.person_uuid ? { id: r.person_uuid, name: pp?.email ?? pp?.name ?? r.distinct_id } : null };
    }),
  };
}
