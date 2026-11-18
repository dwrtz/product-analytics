// Event-table primitives shared by EventShard (one Durable Object per project and period) and the head ProjectStore's
// legacy `events` table (design.md "Event shards"). Each primitive runs only event-level SQL and returns compact rows
// keyed by distinct_id; person-level work (person filters, person breakdowns, unique users) happens in the head.
import { ActionStep, needsJs, jsConditionsMatch } from '../shared/actions';
export type PropertyFilter = { key: string; value?: unknown; operator?: string; type?: 'event' | 'person' | 'cohort' | string };
/** An event matcher: an event name (null = any) and event filters, or an action (any of its steps; design.md "Actions"). */
export type NodeSpec = { event?: string | null; properties?: PropertyFilter[]; action?: { id: number; steps: ActionStep[]; ids?: (number[] | null)[] } | null };
export class QueryError extends Error { constructor(msg: string) { super(msg); } }
export const NONE = '$$_none_$$';

export const EVENTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, event TEXT NOT NULL, distinct_id TEXT NOT NULL,
     timestamp INTEGER NOT NULL, properties TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_ts ON events (timestamp)`,
  `CREATE INDEX IF NOT EXISTS events_event_ts ON events (event, timestamp)`,
  `CREATE INDEX IF NOT EXISTS events_did_ts ON events (distinct_id, timestamp)`,
];

type Sql = { sql: string; params: SqlStorageValue[] };
export const pathOf = (key: string) => { if (typeof key !== 'string' || !key || key.length > 400) throw new QueryError('bad property key'); return '$.' + JSON.stringify(key); };
const OPS = new Set(['exact', 'is_not', 'icontains', 'not_icontains', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_not_set', 'is_date_before', 'is_date_after']);
export const isPersonFilter = (f: PropertyFilter) => f.type === 'person' || f.type === 'cohort';
export function validateFilters(fs: PropertyFilter[] | undefined) {
  for (const f of fs ?? []) {
    if (!f || !f.key) continue;
    if (f.type === 'cohort') { if (!Number.isInteger(Number(f.value))) throw new QueryError('cohort filter needs a cohort id'); if (f.operator && !['in', 'not_in', 'exact'].includes(f.operator)) throw new QueryError('cohort filter operator must be in or not_in'); continue; }
    pathOf(f.key);
    const op = f.operator ?? 'exact'; if (!OPS.has(op)) throw new QueryError(`unsupported operator ${op}`);
    if (op === 'is_date_before' || op === 'is_date_after') { const v = Array.isArray(f.value) ? f.value[0] : f.value; if (!Number.isFinite(Date.parse(String(v)))) throw new QueryError('bad date value'); }
  }
}

/** validateFilters for stored definitions: an error message instead of an exception. */
export function validateFiltersSafe(fs: unknown): string | null {
  if (fs !== undefined && !Array.isArray(fs)) return 'properties must be a list';
  try { validateFilters(fs as PropertyFilter[]); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
/** Text form of a JSON property: booleans as true/false, numbers as SQLite prints them, null when missing. */
function textExpr(src: string, key: string): Sql {
  const p = pathOf(key);
  return { sql: `(CASE json_type(${src}, ?) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'object' THEN json_extract(${src}, ?) WHEN 'array' THEN json_extract(${src}, ?) ELSE CAST(json_extract(${src}, ?) AS TEXT) END)`, params: [p, p, p, p] };
}
const filterVals = (f: PropertyFilter) => (Array.isArray(f.value) ? f.value : [f.value]).filter(v => v !== undefined && v !== null).map(v => typeof v === 'string' ? v : JSON.stringify(v));
function propertySql(f: PropertyFilter): Sql {
  const src = 'e.properties'; const t = textExpr(src, f.key); const op = f.operator ?? 'exact';
  const vals = filterVals(f);
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
/** Event-level filters only; person filters are applied by the head. */
function filtersSql(fs: PropertyFilter[] | undefined): Sql {
  const parts = (fs ?? []).filter(f => f && f.key && !isPersonFilter(f)).map(propertySql);
  if (!parts.length) return { sql: '1', params: [] };
  return { sql: parts.map(p => `(${p.sql})`).join(' AND '), params: parts.flatMap(p => p.params) };
}
/** The SQL-expressible part of an action step (event, exact/contains url and text, event properties). */
export function stepSql(st: ActionStep): Sql {
  const parts: Sql[] = [filtersSql(st.properties as PropertyFilter[])];
  if (st.event) parts.push({ sql: 'e.event = ?', params: [st.event] });
  const str = (key: string, v: string | null | undefined, how: string | undefined) => {
    if (!v || how === 'regex') return;
    const t = textExpr('e.properties', key);
    parts.push(how === 'contains' ? { sql: `instr(lower(${t.sql}), lower(?)) > 0`, params: [...t.params, v] } : { sql: `${t.sql} = ?`, params: [...t.params, v] });
  };
  str('$current_url', st.url, st.url_matching); str('$el_text', st.text, st.text_matching);
  return and(...parts);
}
function nodeSql(n: NodeSpec): Sql {
  const f = filtersSql(n.properties);
  if (n.action) {
    const steps = n.action.steps.map((st, k) => {
      const base = stepSql(st);
      if (!needsJs(st)) return base;
      const ids = n.action!.ids?.[k];
      if (!ids) throw new QueryError('action step was not prepared');
      return { sql: `${base.sql} AND e.id IN (SELECT value FROM json_each(?))`, params: [...base.params, JSON.stringify(ids)] };
    });
    if (!steps.length) return { sql: '0', params: [] };
    return { sql: `(${steps.map(x => `(${x.sql})`).join(' OR ')}) AND ${f.sql}`, params: [...steps.flatMap(x => x.params), ...f.params] };
  }
  if (n.event === null || n.event === undefined || n.event === '') return f;
  return { sql: `e.event = ? AND ${f.sql}`, params: [n.event, ...f.params] };
}
/**
 * Evaluates the JS-only conditions of action steps (selector, href, regex) over the events in [from, to) that pass the
 * step's SQL part, and records the matching row ids on the node so nodeSql can use them. Mutates the node.
 */
export function prepareNode(sql: SqlStorage, n: NodeSpec, from: number, to: number) {
  if (!n.action) return;
  n.action.ids = n.action.steps.map(st => {
    if (!needsJs(st)) return null;
    const base = stepSql(st); const ids: number[] = [];
    for (const r of sql.exec(`SELECT e.id, e.properties FROM events e WHERE e.timestamp >= ? AND e.timestamp < ? AND ${base.sql}`, from, to, ...base.params)) {
      let props: Record<string, unknown>; try { props = JSON.parse(String(r.properties)); } catch { continue; }
      if (jsConditionsMatch(st, props)) ids.push(Number(r.id));
    }
    return ids;
  });
}
const span = (bs: [number, number][]) => [Math.min(...bs.map(b => b[0])), Math.max(...bs.map(b => b[1]))] as const;
const and = (...s: Sql[]): Sql => ({ sql: s.map(x => `(${x.sql})`).join(' AND '), params: s.flatMap(x => x.params) });
const bdSql = (key: string | null | undefined): Sql => key ? (() => { const t = textExpr('e.properties', key); return { sql: `COALESCE(${t.sql}, '${NONE}')`, params: t.params }; })() : { sql: `'${NONE}'`, params: [] };
const bucketCte = (bs: [number, number][]): Sql => ({ sql: `b(i, s, en) AS (SELECT CAST(key AS INTEGER), json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`, params: [JSON.stringify(bs)] });

// ---------- primitives ----------
export type TrendSpec = {
  buckets: [number, number][]; node: NodeSpec; global?: PropertyFilter[]; breakdown?: string | null;
  numKey?: string | null; extra?: 'session' | { group: string } | null; values?: boolean;
};
/** Grouped rows [bucket, distinct_id, breakdown, count, sum, min, max, numericCount, extra] or, with values, [bucket, distinct_id, breakdown, value]. */
export function trendRows(sql: SqlStorage, s: TrendSpec): unknown[][] {
  if (s.node.action) { const [a, b] = span(s.buckets); prepareNode(sql, s.node, a, b); }
  const where = and(nodeSql(s.node), filtersSql(s.global)); const bd = bdSql(s.breakdown); const cte = bucketCte(s.buckets);
  const num: Sql = s.numKey ? { sql: `CAST(json_extract(e.properties, ?) AS REAL)`, params: [pathOf(s.numKey)] } : { sql: 'NULL', params: [] };
  if (s.values) {
    return [...sql.exec(`WITH ${cte.sql} SELECT b.i, e.distinct_id, ${bd.sql}, ${num.sql} AS v FROM b JOIN events e ON e.timestamp >= b.s AND e.timestamp < b.en WHERE ${where.sql} AND ${num.sql} IS NOT NULL`,
      ...cte.params, ...bd.params, ...num.params, ...where.params, ...num.params).raw()];
  }
  const ex: Sql = s.extra === 'session' ? { sql: `json_extract(e.properties, '$."$session_id"')`, params: [] }
    : s.extra && typeof s.extra === 'object' ? { sql: `json_extract(e.properties, ?)`, params: ['$."$groups".' + JSON.stringify(s.extra.group)] } : { sql: 'NULL', params: [] };
  return [...sql.exec(`WITH ${cte.sql} SELECT b.i AS bi, e.distinct_id AS did, ${bd.sql} AS bv, COUNT(*), SUM(${num.sql}), MIN(${num.sql}), MAX(${num.sql}), COUNT(${num.sql}), ${ex.sql} AS ex
      FROM b JOIN events e ON e.timestamp >= b.s AND e.timestamp < b.en WHERE ${where.sql} GROUP BY bi, did, bv, ex`,
    ...cte.params, ...bd.params, ...num.params, ...num.params, ...num.params, ...num.params, ...ex.params, ...where.params).raw()];
}

export type FunnelSpec = { from: number; to: number; steps: NodeSpec[]; global?: PropertyFilter[]; breakdown?: string | null; value?: string | null; distinctIds?: string[] | null };
/** Rows [distinct_id, ts, stepMask, breakdown, value] for events matching any step, in (distinct_id, time) order. */
export function funnelRows(sql: SqlStorage, s: FunnelSpec): unknown[][] {
  for (const st of s.steps) prepareNode(sql, st, s.from, s.to + 1);
  const conds = s.steps.map(nodeSql); const g = filtersSql(s.global); const bd = bdSql(s.breakdown);
  const val: Sql = s.value ? { sql: 'CAST(json_extract(e.properties, ?) AS REAL)', params: [pathOf(s.value)] } : { sql: 'NULL', params: [] };
  const mask = conds.map((c, k) => ({ sql: `(CASE WHEN ${c.sql} THEN ${2 ** k} ELSE 0 END)`, params: c.params }));
  const any = { sql: conds.map(c => `(${c.sql})`).join(' OR '), params: conds.flatMap(c => c.params) };
  const dids: Sql = s.distinctIds ? { sql: 'e.distinct_id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(s.distinctIds)] } : { sql: '1', params: [] };
  return [...sql.exec(`SELECT e.distinct_id, e.timestamp, ${mask.map(m => m.sql).join(' + ')}, ${bd.sql}, ${val.sql} FROM events e WHERE e.timestamp >= ? AND e.timestamp <= ? AND (${any.sql}) AND ${g.sql} AND ${dids.sql} ORDER BY e.distinct_id, e.timestamp, e.id`,
    ...mask.flatMap(m => m.params), ...bd.params, ...val.params, s.from, s.to, ...any.params, ...g.params, ...dids.params).raw()];
}
/** Pass 1 of a streamed funnel: [distinct_id, matching event count] (design.md "Streaming aggregation"). */
export function funnelCountRows(sql: SqlStorage, s: FunnelSpec): unknown[][] {
  for (const st of s.steps) prepareNode(sql, st, s.from, s.to + 1);
  const conds = s.steps.map(nodeSql); const g = filtersSql(s.global);
  const any = { sql: conds.map(c => `(${c.sql})`).join(' OR '), params: conds.flatMap(c => c.params) };
  return [...sql.exec(`SELECT e.distinct_id, COUNT(*) FROM events e WHERE e.timestamp >= ? AND e.timestamp <= ? AND (${any.sql}) AND ${g.sql} GROUP BY e.distinct_id`, s.from, s.to, ...any.params, ...g.params).raw()];
}

export type PeriodSpec = { buckets: [number, number][]; node: NodeSpec; global?: PropertyFilter[] };
/** Distinct [distinct_id, bucket] pairs with a matching event. */
export function periodRows(sql: SqlStorage, s: PeriodSpec): unknown[][] {
  if (s.node.action) { const [a, b] = span(s.buckets); prepareNode(sql, s.node, a, b); }
  const c = and(nodeSql(s.node), filtersSql(s.global)); const cte = bucketCte(s.buckets);
  return [...sql.exec(`WITH ${cte.sql} SELECT DISTINCT e.distinct_id, b.i FROM b JOIN events e ON e.timestamp >= b.s AND e.timestamp < b.en WHERE ${c.sql}`, ...cte.params, ...c.params).raw()];
}
/** [distinct_id, first matching timestamp] before `before`. */
export function firstRows(sql: SqlStorage, s: { node: NodeSpec; global?: PropertyFilter[]; before: number }): unknown[][] {
  prepareNode(sql, s.node, -8.64e15, s.before);
  const c = and(nodeSql(s.node), filtersSql(s.global));
  return [...sql.exec(`SELECT e.distinct_id, MIN(e.timestamp) FROM events e WHERE e.timestamp < ? AND ${c.sql} GROUP BY e.distinct_id`, s.before, ...c.params).raw()];
}

export type EventsSpec = { event?: string | null; excludeEvents?: string[] | null; properties?: PropertyFilter[]; distinctIds?: string[] | null; after?: number | null; before?: number | null; cursor?: [number, string] | null; limit: number };
export type EventRow = { uuid: string; event: string; distinct_id: string; timestamp: number; properties: string };
/** Newest first by (timestamp, uuid). */
export function eventRows(sql: SqlStorage, s: EventsSpec): EventRow[] {
  const parts: Sql[] = [filtersSql(s.properties)];
  if (s.event) parts.push({ sql: 'e.event = ?', params: [String(s.event)] });
  if (s.excludeEvents?.length) parts.push({ sql: 'e.event NOT IN (SELECT value FROM json_each(?))', params: [JSON.stringify(s.excludeEvents)] });
  if (s.distinctIds) parts.push({ sql: 'e.distinct_id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(s.distinctIds)] });
  if (s.after != null) parts.push({ sql: 'e.timestamp >= ?', params: [s.after] });
  if (s.before != null) parts.push({ sql: 'e.timestamp < ?', params: [s.before] });
  if (s.cursor) parts.push({ sql: '(e.timestamp < ? OR (e.timestamp = ? AND e.uuid < ?))', params: [s.cursor[0], s.cursor[0], s.cursor[1]] });
  const w = and(...parts);
  return sql.exec(`SELECT e.uuid, e.event, e.distinct_id, e.timestamp, e.properties FROM events e WHERE ${w.sql} ORDER BY e.timestamp DESC, e.uuid DESC LIMIT ?`, ...w.params, s.limit).toArray() as EventRow[];
}
export function propertyValueRows(sql: SqlStorage, key: string): string[] {
  const path = pathOf(key);
  return sql.exec('SELECT DISTINCT CAST(json_extract(properties, ?) AS TEXT) AS v FROM (SELECT properties FROM events ORDER BY timestamp DESC LIMIT 5000) WHERE json_extract(properties, ?) IS NOT NULL LIMIT 50', path, path).toArray().map(r => String(r.v));
}
export function eventStats(sql: SqlStorage, since: number) {
  const r = sql.exec('SELECT COUNT(*) AS c, SUM(timestamp > ?) AS d, MAX(created_at) AS l, MIN(timestamp) AS mn FROM events', since).one();
  return { events: Number(r.c), events_24h: Number(r.d ?? 0), last_event_at: (r.l as number | null) ?? null, min_ts: (r.mn as number | null) ?? null };
}
export function purgeBefore(sql: SqlStorage, beforeMs: number) {
  let total = 0;
  for (;;) { const n = sql.exec('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE timestamp < ? LIMIT 5000) RETURNING id', beforeMs).toArray().length; total += n; if (n < 5000) break; }
  return total;
}
export function deleteDistinctIds(sql: SqlStorage, dids: string[]) {
  return sql.exec('DELETE FROM events WHERE distinct_id IN (SELECT value FROM json_each(?)) RETURNING id', JSON.stringify(dids)).toArray().length;
}

// ---------- person-side evaluation (head) ----------
/** JS mirror of the SQL text form above, for person properties. */
export function textOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
const realOf = (v: unknown): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(v); return m ? Number(m[0]) : 0; }
  return 0;
};
/** Person-property filter with the same semantics as the event SQL. */
export function matchPerson(f: PropertyFilter, props: Record<string, unknown>): boolean {
  const raw = props[f.key]; const t = textOf(raw); const op = f.operator ?? 'exact'; const vals = filterVals(f);
  switch (op) {
    case 'exact': return t !== null && vals.includes(t);
    case 'is_not': return t === null || !vals.includes(t);
    case 'icontains': return t !== null && t.toLowerCase().includes(String(vals[0] ?? '').toLowerCase());
    case 'not_icontains': return t === null || !t.toLowerCase().includes(String(vals[0] ?? '').toLowerCase());
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = realOf(raw), b = Number(vals[0]); if (a === null) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'is_set': return raw !== undefined && raw !== null;
    case 'is_not_set': return raw === undefined || raw === null;
    case 'is_date_before': case 'is_date_after': {
      const a = typeof raw === 'string' || typeof raw === 'number' ? Date.parse(String(raw)) : NaN; const b = Date.parse(String(vals[0]));
      if (!Number.isFinite(a)) return false; return op === 'is_date_before' ? a < b : a > b;
    }
    default: throw new QueryError(`unsupported operator ${op}`);
  }
}

// ---------- heatmaps (design.md "Heatmaps") ----------
/** posthog-js `$$heatmap` events carry `$heatmap_data = {<url>: [{x, y, target_fixed, type}]}` with page CSS px. */
export type HeatmapSpec = { from: number; to: number; type?: string | null; urlExact?: string | null; urlLike?: string | null; vwMin?: number | null; vwMax?: number | null; urls?: boolean };
const heatmapWhere = (s: HeatmapSpec): Sql => {
  const parts: Sql[] = [{ sql: "e.event = '$$heatmap' AND e.timestamp >= ? AND e.timestamp < ?", params: [s.from, s.to] }];
  if (s.type) parts.push({ sql: "json_extract(p.value, '$.type') = ?", params: [s.type] });
  if (s.urlExact) parts.push({ sql: 'j.key = ?', params: [s.urlExact] });
  if (s.urlLike) parts.push({ sql: 'j.key LIKE ?', params: [s.urlLike] });
  if (s.vwMin != null) parts.push({ sql: `CAST(json_extract(e.properties, '$."$viewport_width"') AS REAL) >= ?`, params: [s.vwMin] });
  if (s.vwMax != null) parts.push({ sql: `CAST(json_extract(e.properties, '$."$viewport_width"') AS REAL) <= ?`, params: [s.vwMax] });
  return and(...parts);
};
/**
 * Rows [relative x (0-100), y bucket (16 px), target_fixed, count, unique distinct ids], or with `urls` the URLs that have
 * heatmap data [url, count]. x is relative to the viewport width so pages can be overlaid at any width.
 */
export function heatmapRows(sql: SqlStorage, s: HeatmapSpec): unknown[][] {
  const w = heatmapWhere(s);
  const from = `FROM events e, json_each(e.properties, '$."$heatmap_data"') j, json_each(j.value) p`;
  if (s.urls) return [...sql.exec(`SELECT j.key, COUNT(*) ${from} WHERE ${w.sql} GROUP BY j.key ORDER BY 2 DESC LIMIT 200`, ...w.params).raw()];
  return [...sql.exec(`SELECT CAST(round(CAST(json_extract(p.value, '$.x') AS REAL) * 100.0 / MAX(1, CAST(json_extract(e.properties, '$."$viewport_width"') AS REAL))) AS INTEGER) AS rx,
      (CAST(json_extract(p.value, '$.y') AS INTEGER) / 16) * 16 AS yb, COALESCE(json_extract(p.value, '$.target_fixed'), 0) AS fixed, COUNT(*), COUNT(DISTINCT e.distinct_id)
    ${from} WHERE ${w.sql} AND json_extract(p.value, '$.x') IS NOT NULL GROUP BY rx, yb, fixed LIMIT 100000`, ...w.params).raw()];
}
/**
 * Scroll depth: posthog-js reports, for the page being left, `$prev_pageview_pathname` and
 * `$prev_pageview_max_scroll_percentage` (0..1) on the next `$pageview` or on `$pageleave`. Rows [5% bucket (0-20), count].
 */
export function scrollRows(sql: SqlStorage, s: { from: number; to: number; pathname?: string | null }): unknown[][] {
  const path: Sql = s.pathname ? { sql: `AND json_extract(e.properties, '$."$prev_pageview_pathname"') = ?`, params: [s.pathname] } : { sql: '', params: [] };
  return [...sql.exec(`SELECT MIN(20, MAX(0, CAST(CAST(json_extract(e.properties, '$."$prev_pageview_max_scroll_percentage"') AS REAL) * 20 AS INTEGER))) AS b, COUNT(*)
    FROM events e WHERE e.event IN ('$pageview', '$pageleave') AND e.timestamp >= ? AND e.timestamp < ?
      AND json_extract(e.properties, '$."$prev_pageview_max_scroll_percentage"') IS NOT NULL ${path.sql} GROUP BY b`, s.from, s.to, ...path.params).raw()];
}
