// Cold tier (design.md "Cold tier"): every ingested event is also sent to a Basin Pipelines stream (COLD_STREAM) that
// writes an Apache Iceberg table in R2 (Basin Catalog). The SQL editor's "Cold" source compiles the same parsed AST
// as the hot engine (sqlquery.ts) to one Basin SQL query. Nothing the user typed is spliced in as SQL: column names
// come from a fixed set, strings and property keys are quoted literals, and the compiler always adds
// `project_id = <this project>` and, when the project has a retention period, `timestamp >= now - retention_days`.
import { QueryError } from './eventsql';
import { prepareSelect, hasAgg, isDt, LIMITS, type Expr, type SqlResult } from './sqlquery';
import type { Env, NormEvent } from './env';
import { resolveRange, buckets as tzBuckets, label as tzLabel, type Interval } from '../shared/dates';

export type ColdRecord = { project_id: number; uuid: string; event: string; distinct_id: string; timestamp: string; ts: number; properties: string };
export const coldRecord = (pid: number, e: NormEvent): ColdRecord =>
  ({ project_id: pid, uuid: e.uuid, event: e.event, distinct_id: e.distinct_id, timestamp: new Date(e.ts).toISOString(), ts: e.ts, properties: JSON.stringify(e.properties ?? {}) });

export const coldEnabled = (env: Env) => !!(env.COLD_STREAM && env.BASIN_TOKEN && env.BASIN_ACCOUNT_ID && env.BASIN_BUCKET);
export const coldTable = (env: Env) => {
  const t = env.BASIN_TABLE || 'analytics.events';
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(t)) throw new Error('BASIN_TABLE must look like namespace.table');
  return t;
};

const str = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const num = (n: number) => { if (!Number.isFinite(n)) throw new QueryError('bad number'); return Number.isInteger(n) ? String(n) : String(n); };
type Want = 'str' | 'num';

/** Compiles one expression (event columns only) to Basin SQL (DataFusion dialect). Datetimes are epoch milliseconds,
 * like the hot engine: `timestamp` maps to the `ts` column. */
export function compileCold(e: Expr, now: number, want: Want = 'str'): string {
  const c = (x: Expr, w: Want = 'str') => compileCold(x, now, w);
  const numeric = (x: Expr) => (x.k === 'lit' && typeof x.v === 'number') || isDt(x) || x.k === 'neg' || (x.k === 'bin' && ['+', '-', '*', '/', '%'].includes(x.op)) || (x.k === 'fn' && ['length', 'abs', 'floor', 'ceil', 'round', 'toint', 'tofloat', 'count', 'sum', 'avg', 'uniq', 'uniqexact', 'countif', 'sumif', 'position'].includes(x.name));
  switch (e.k) {
    case 'lit': return e.v === null ? 'NULL' : typeof e.v === 'number' ? num(e.v) : str(e.v);
    case 'col': {
      if (e.table !== 'event') throw new QueryError('person columns are not available in the cold tier; use the hot source');
      if (e.name === 'timestamp') return 'ts';
      if (e.name === 'properties') {
        if (!e.path) return 'properties';
        const keys = e.path.map(str).join(', ');
        return want === 'num' ? `json_get_float(properties, ${keys})` : `json_get_str(properties, ${keys})`;
      }
      return e.name;
    }
    case 'bin': {
      if (e.op === 'AND' || e.op === 'OR') return `(${c(e.a)} ${e.op} ${c(e.b)})`;
      const w: Want = ['+', '-', '*', '/', '%'].includes(e.op) || numeric(e.a) || numeric(e.b) ? 'num' : 'str';
      if (e.op === '/') return `(CAST(${c(e.a, 'num')} AS DOUBLE) / ${c(e.b, 'num')})`;
      return `(${c(e.a, w)} ${e.op} ${c(e.b, w)})`;
    }
    case 'not': return `(NOT ${c(e.a)})`;
    case 'neg': return `(-${c(e.a, 'num')})`;
    case 'isnull': return `(${c(e.a)} IS ${e.not ? 'NOT ' : ''}NULL)`;
    case 'in': { const w: Want = e.list.every(x => x.k === 'lit' && typeof x.v === 'number') ? 'num' : 'str'; return `(${c(e.a, w)} ${e.not ? 'NOT ' : ''}IN (${e.list.map(x => c(x, w)).join(', ')}))`; }
    case 'like': return e.ci ? `(lower(${c(e.a)}) ${e.not ? 'NOT ' : ''}LIKE lower(${c(e.b)}))` : `(${c(e.a)} ${e.not ? 'NOT ' : ''}LIKE ${c(e.b)})`;
    case 'between': { const w: Want = numeric(e.lo) || numeric(e.hi) ? 'num' : 'str'; return `(${c(e.a, w)} ${e.not ? 'NOT ' : ''}BETWEEN ${c(e.lo, w)} AND ${c(e.hi, w)})`; }
    case 'ref': throw new QueryError('internal: unresolved reference');
    case 'fn': {
      const A = (w: Want = 'str') => e.args.map(x => c(x, w));
      const a0 = (w: Want = 'str') => { if (!e.args[0]) throw new QueryError(`${e.name} needs an argument`); return c(e.args[0], w); };
      const n = e.name;
      switch (n) {
        case 'count': return e.star || !e.args.length ? 'COUNT(*)' : e.distinct ? `COUNT(DISTINCT ${a0()})` : `COUNT(${a0()})`;
        case 'uniqexact': return `COUNT(DISTINCT ${a0()})`;
        case 'uniq': return `approx_distinct(${a0()})`;
        case 'sum': case 'avg': return `${n.toUpperCase()}(${a0('num')})`;
        case 'min': case 'max': return `${n.toUpperCase()}(${a0(isDt(e.args[0]) ? 'num' : 'str')})`;
        case 'countif': return `SUM(CASE WHEN ${a0()} THEN 1 ELSE 0 END)`;
        case 'sumif': { if (e.args.length !== 2) throw new QueryError('sumIf(value, condition)'); return `SUM(CASE WHEN ${c(e.args[1])} THEN ${c(e.args[0], 'num')} ELSE 0 END)`; }
        case 'lower': case 'upper': return `${n}(${a0()})`;
        case 'length': return `character_length(${a0()})`;
        case 'trim': return `btrim(${a0()})`;
        case 'abs': return `abs(${a0('num')})`;
        case 'floor': return `CAST(floor(${a0('num')}) AS BIGINT)`;
        case 'ceil': return `CAST(ceil(${a0('num')}) AS BIGINT)`;
        case 'round': return e.args.length > 1 ? `round(${a0('num')}, ${c(e.args[1], 'num')})` : `round(${a0('num')})`;
        case 'coalesce': case 'ifnull': return `coalesce(${A().join(', ')}${e.args.length < 2 ? ', NULL' : ''})`;
        case 'greatest': case 'least': { const w: Want = e.args.some(numeric) ? 'num' : 'str'; return `${n}(${A(w).join(', ')})`; }
        case 'concat': return '(' + e.args.map(x => `coalesce(CAST(${c(x)} AS VARCHAR), '')`).join(' || ') + ')';
        case 'tostring': return `CAST(${a0()} AS VARCHAR)`;
        case 'toint': return `TRY_CAST(${a0('num')} AS BIGINT)`;
        case 'tofloat': return `TRY_CAST(${a0('num')} AS DOUBLE)`;
        case 'if': if (e.args.length !== 3) throw new QueryError('if(cond, then, else)'); return `(CASE WHEN ${c(e.args[0])} THEN ${c(e.args[1])} ELSE ${c(e.args[2])} END)`;
        case 'now': return num(now);
        case 'today': return num(Math.floor(now / 86400_000) * 86400_000);
        case 'tostartofhour': return `((CAST(${a0('num')} AS BIGINT) / 3600000) * 3600000)`;
        case 'tostartofday': case 'todate': return `((CAST(${a0('num')} AS BIGINT) / 86400000) * 86400000)`;
        // Weeks start on Sunday, as in the hot engine (1970-01-01 was a Thursday).
        case 'tostartofweek': { const d = `(CAST(${a0('num')} AS BIGINT) / 86400000)`; return `((${d} - ((${d} + 4) % 7)) * 86400000)`; }
        case 'tostartofmonth': return `(CAST(to_unixtime(date_trunc('month', to_timestamp_millis(CAST(${a0('num')} AS BIGINT)))) AS BIGINT) * 1000)`;
        case 'todatetime': throw new QueryError('toDateTime takes a string literal');
        case 'substring': return `substr(${[c(e.args[0]), ...e.args.slice(1).map(x => c(x, 'num'))].join(', ')})`;
        case 'startswith': return `starts_with(${A().join(', ')})`;
        case 'endswith': return `ends_with(${A().join(', ')})`;
        case 'position': return `strpos(${A().join(', ')})`;
      }
      throw new QueryError(`${e.name} cannot be used in the cold tier`);
    }
  }
}

export type ColdQuery = { sql: string; columns: string[]; types: string[]; limit: number; offset: number };
/** Builds the full Basin SQL statement for a SQL-editor query against this project's cold events. */
export function buildColdQuery(src: string, o: { table: string; projectId: number; retentionDays: number; now: number }): ColdQuery {
  const { sel, items, types, aggregate } = prepareSelect(src);
  if (sel.from !== 'events') throw new QueryError('the cold tier only has events; query persons with the hot source');
  if (!Number.isSafeInteger(o.projectId) || o.projectId <= 0) throw new Error('bad project id');
  const conds = [`project_id = ${o.projectId}`];
  if (o.retentionDays > 0) {
    const cutoff = o.now - o.retentionDays * 86400_000;
    // `timestamp` (Iceberg timestamp) lets Basin SQL prune files; `ts` is the same instant in epoch ms.
    conds.push(`timestamp >= to_timestamp_millis(${cutoff})`, `ts >= ${cutoff}`);
  }
  if (sel.where) conds.push(compileCold(sel.where, o.now));
  const sel1 = items.map((it, i) => `${compileCold(it.e, o.now)} AS c${i}`).join(', ');
  const group = sel.groupBy.map(g => compileCold(g, o.now));
  if (aggregate) for (const it of items) if (!hasAgg(it.e) && !sel.groupBy.some(g => JSON.stringify(g) === JSON.stringify(it.e)) && JSON.stringify(it.e).includes('"k":"col"')) throw new QueryError(`${it.name} must be in GROUP BY or inside an aggregate`);
  const order = sel.orderBy.map(ob => { const i = items.findIndex(it => JSON.stringify(it.e) === JSON.stringify(ob.e)); return `${i >= 0 ? `c${i}` : compileCold(ob.e, o.now)} ${ob.desc ? 'DESC' : 'ASC'}`; });
  const limit = Math.min(sel.limit, LIMITS.resultRows);
  const sql = `SELECT ${sel.distinct ? 'DISTINCT ' : ''}${sel1} FROM ${o.table} WHERE ${conds.join(' AND ')}`
    + (group.length ? ` GROUP BY ${group.join(', ')}` : '')
    + (sel.having ? ` HAVING ${compileCold(sel.having, o.now)}` : '')
    + (order.length ? ` ORDER BY ${order.join(', ')}` : '')
    + ` LIMIT ${limit + 1}` + (sel.offset ? ` OFFSET ${sel.offset}` : '');
  return { sql, columns: items.map(i => i.name), types, limit, offset: sel.offset };
}

export type BasinResponse = { success: boolean; errors?: { code: number; message: string }[]; result?: { schema?: { name: string }[]; rows?: Record<string, unknown>[]; metrics?: { bytes_scanned?: number; files_scanned?: number } } };
export async function basinSql(env: Env, sql: string): Promise<BasinResponse> {
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.BASIN_ACCOUNT_ID}/basin-sql/query/${env.BASIN_BUCKET}`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), LIMITS.timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { authorization: `Bearer ${env.BASIN_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ warehouse: `${env.BASIN_ACCOUNT_ID}_${env.BASIN_BUCKET}`, query: sql }) });
    const text = await r.text(); let body: BasinResponse;
    try { body = JSON.parse(text); } catch { throw new Error(`Basin SQL returned HTTP ${r.status}`); }
    return body;
  } catch (e) { if ((e as Error).name === 'AbortError') throw new QueryError(`query timed out after ${LIMITS.timeoutMs / 1000}s`); throw e; }
  finally { clearTimeout(t); }
}

export async function runColdSql(env: Env, src: string, o: { projectId: number; retentionDays: number; now?: number }): Promise<SqlResult & { source: 'cold'; scanned?: { bytes?: number; files?: number } }> {
  if (!coldEnabled(env)) throw new QueryError('the cold tier is not configured on this instance');
  const q = buildColdQuery(src, { table: coldTable(env), projectId: o.projectId, retentionDays: o.retentionDays, now: o.now ?? Date.now() });
  const r = await basinSql(env, q.sql);
  if (!r.success) {
    const msg = (r.errors ?? []).map(e => e.message).join('; ') || 'query failed';
    // The table appears after the pipeline's first file roll (about a minute after the first event).
    if (/not found|does not exist|no such table|table .* not/i.test(msg)) return { source: 'cold', columns: q.columns, types: q.types, results: [], hasMore: false, limit: q.limit, offset: q.offset };
    throw new QueryError(`Basin SQL: ${msg}`);
  }
  const rows = r.result?.rows ?? [];
  const results = rows.slice(0, q.limit).map(row => q.columns.map((_, i) => { const v = row[`c${i}`] ?? null; return q.types[i] === 'DateTime' && v !== null && !Number.isNaN(Number(v)) ? new Date(Number(v)).toISOString() : typeof v === 'bigint' ? Number(v) : v; }));
  return { source: 'cold', columns: q.columns, types: q.types, results, hasMore: rows.length > q.limit, limit: q.limit, offset: q.offset, scanned: { bytes: r.result?.metrics?.bytes_scanned, files: r.result?.metrics?.files_scanned } };
}

// ---------- 0.6: Trends over the cold tier (design.md "Cold tier", "Cold Trends") ----------
// A Trends query (series of events with event-property filters, math total / dau / unique_session, hour-month buckets
// in the project time zone) compiles to one Basin SQL GROUP BY per series. Bucket boundaries are computed here in the
// project time zone and passed as a CASE over `ts`, so time zones with half-hour offsets and DST work. The project and
// retention filters are always added, like the SQL editor's cold source. Funnels, retention, breakdowns, actions and
// person or cohort filters stay on the hot shards.

export const COLD_TRENDS_MAX_BUCKETS = 400;
const COLD_MATHS = new Set(['total', 'dau', 'unique_session']);
const AGG = new Set(['BoldNumber', 'ActionsTable', 'ActionsPie', 'ActionsBarValue']);
export type ColdTrendsPlan = { statements: string[]; buckets: { start: number; end: number; label: string }[]; series: any[]; range: { from: number; to: number }; interval: Interval; aggregated: boolean };

function coldFilter(f: any): string {
  if (!f || !f.key) throw new QueryError('every filter needs a key');
  if (f.type === 'person' || f.type === 'cohort' || f.type === 'group') throw new QueryError('person, group and cohort filters need the hot source');
  if (typeof f.key !== 'string' || f.key.length > 400) throw new QueryError('bad property key');
  const k = str(f.key); const t = `json_get_str(properties, ${k})`; const num = `json_get_float(properties, ${k})`;
  const vals = (Array.isArray(f.value) ? f.value : [f.value]).filter((v: unknown) => v !== undefined && v !== null).map((v: unknown) => typeof v === 'string' ? v : JSON.stringify(v));
  const op = f.operator ?? 'exact';
  const nval = () => { const x = Number(vals[0]); if (!Number.isFinite(x)) throw new QueryError(`${op} needs a number`); return String(x); };
  switch (op) {
    case 'exact': if (!vals.length) throw new QueryError('exact needs a value'); return `${t} IN (${vals.map(str).join(', ')})`;
    case 'is_not': if (!vals.length) throw new QueryError('is_not needs a value'); return `(${t} IS NULL OR ${t} NOT IN (${vals.map(str).join(', ')}))`;
    case 'icontains': return `strpos(lower(${t}), lower(${str(String(vals[0] ?? ''))})) > 0`;
    case 'not_icontains': return `(${t} IS NULL OR strpos(lower(${t}), lower(${str(String(vals[0] ?? ''))})) = 0)`;
    case 'gt': return `${num} > ${nval()}`; case 'gte': return `${num} >= ${nval()}`;
    case 'lt': return `${num} < ${nval()}`; case 'lte': return `${num} <= ${nval()}`;
    case 'is_set': return `${t} IS NOT NULL`; case 'is_not_set': return `${t} IS NULL`;
  }
  throw new QueryError(`operator ${op} is not supported in the cold tier`);
}

/** Plans a cold Trends query: buckets, one Basin SQL statement per series, with project and retention filters always on. */
export function buildColdTrends(q: any, o: { table: string; projectId: number; retentionDays: number; now: number; timezone: string }): ColdTrendsPlan {
  if (!Number.isSafeInteger(o.projectId) || o.projectId <= 0) throw new Error('bad project id');
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(o.table)) throw new Error('bad table');
  if (q?.kind && q.kind !== 'TrendsQuery') throw new QueryError('only Trends can read the cold tier; use the SQL editor for other cold queries');
  if (q?.breakdownFilter?.breakdown) throw new QueryError('breakdowns need the hot source');
  if (q?.compareFilter?.compare) throw new QueryError('compare to previous period needs the hot source');
  const series: any[] = Array.isArray(q?.series) && q.series.length ? q.series : [{ event: '$pageview' }];
  if (series.length > 20) throw new QueryError('at most 20 series');
  const interval: Interval = ['hour', 'day', 'week', 'month'].includes(q?.interval) ? q.interval : 'day';
  const tz = o.timezone || 'UTC';
  const retainFrom = o.retentionDays > 0 ? o.now - o.retentionDays * 86400_000 : null;
  let range = resolveRange(q?.dateRange?.date_from, q?.dateRange?.date_to, tz, o.now, q?.dateRange?.date_from === 'all' ? (retainFrom ?? o.now - 5 * 365 * 86400_000) : null);
  if (retainFrom !== null && range.from < retainFrom) range = { from: retainFrom, to: Math.max(retainFrom, range.to) };
  const aggregated = AGG.has(q?.trendsFilter?.display);
  const bks = aggregated ? [{ start: range.from, end: range.to + 1, label: `${tzLabel(range.from, 'day', tz)} - ${tzLabel(range.to, 'day', tz)}` }] : tzBuckets(range, interval, tz, COLD_TRENDS_MAX_BUCKETS + 1);
  if (bks.length > COLD_TRENDS_MAX_BUCKETS) throw new QueryError(`the cold tier answers at most ${COLD_TRENDS_MAX_BUCKETS} intervals; pick a larger interval`);
  const lo = Math.max(bks[0].start, range.from); const hi = Math.min(bks[bks.length - 1].end, range.to + 1);
  const bucketExpr = bks.length === 1 ? '0' : `CASE ${bks.slice(1).map((b, i) => `WHEN ts < ${b.start} THEN ${i}`).join(' ')} ELSE ${bks.length - 1} END`;
  const base = [`project_id = ${o.projectId}`];
  if (retainFrom !== null) base.push(`timestamp >= to_timestamp_millis(${retainFrom})`, `ts >= ${retainFrom}`);
  base.push(`ts >= ${lo}`, `ts < ${hi}`);
  const global = (Array.isArray(q?.properties) ? q.properties : []).filter((f: any) => f && f.key).map(coldFilter);
  const statements = series.map((s: any) => {
    if (s.kind === 'ActionsNode' || (s.id != null && s.event === undefined)) throw new QueryError('actions need the hot source');
    const math = s.math ?? 'total'; if (!COLD_MATHS.has(math)) throw new QueryError(`math ${math} needs the hot source (the cold tier has total, dau and unique_session)`);
    const agg = math === 'dau' ? 'COUNT(DISTINCT distinct_id)' : math === 'unique_session' ? `COUNT(DISTINCT json_get_str(properties, '$session_id'))` : 'COUNT(*)';
    const conds = [...base, ...(s.event ? [`event = ${str(String(s.event))}`] : []), ...global, ...(Array.isArray(s.properties) ? s.properties.filter((f: any) => f && f.key).map(coldFilter) : [])];
    return `SELECT ${bucketExpr} AS b, ${agg} AS c FROM ${o.table} WHERE ${conds.join(' AND ')} GROUP BY 1 ORDER BY 1`;
  });
  return { statements, buckets: bks, series, range, interval, aggregated };
}
/** Turns per-series rows ({ b, c }) into Trends results shaped like the hot engine's. */
export function coldTrendsResults(plan: ColdTrendsPlan, rows: Record<string, unknown>[][]) {
  return plan.series.map((s: any, i: number) => {
    const data = plan.buckets.map(() => 0);
    for (const r of rows[i] ?? []) { const b = Number(r.b); if (Number.isInteger(b) && b >= 0 && b < data.length) data[b] = Number(r.c) || 0; }
    const name = s.custom_name ?? s.name ?? s.event ?? 'All events'; const count = data.reduce((a, b) => a + b, 0);
    return { label: name, action: { id: s.event ?? null, type: 'events', name, custom_name: s.custom_name ?? null, order: i, math: s.math ?? 'total', math_property: null },
      data, labels: plan.buckets.map(b => b.label), days: plan.buckets.map(b => new Date(b.start).toISOString()), count, aggregated_value: plan.aggregated ? data[0] : undefined };
  });
}
export async function runColdTrends(env: Env, q: any, o: { projectId: number; retentionDays: number; timezone: string; now?: number }) {
  if (!coldEnabled(env)) throw new QueryError('the cold tier is not configured on this instance');
  const plan = buildColdTrends(q, { table: coldTable(env), projectId: o.projectId, retentionDays: o.retentionDays, now: o.now ?? Date.now(), timezone: o.timezone });
  let bytes = 0, files = 0;
  const rows = await Promise.all(plan.statements.map(async sql => {
    const r = await basinSql(env, sql);
    if (!r.success) {
      const msg = (r.errors ?? []).map(e => e.message).join('; ') || 'query failed';
      if (/not found|does not exist|no such table|table .* not/i.test(msg)) return [];
      throw new QueryError(`Basin SQL: ${msg}`);
    }
    bytes += r.result?.metrics?.bytes_scanned ?? 0; files += r.result?.metrics?.files_scanned ?? 0;
    return r.result?.rows ?? [];
  }));
  return { kind: 'TrendsQuery', source: 'cold' as const, results: coldTrendsResults(plan, rows), timezone: o.timezone, interval: plan.interval,
    date_from: new Date(plan.range.from).toISOString(), date_to: new Date(plan.range.to).toISOString(), scanned: { bytes, files } };
}
