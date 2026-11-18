// SQL editor (design.md "SQL"): a read-only SELECT subset over `events` and `persons`, in the spirit of PostHog's
// HogQL. The query is parsed into an AST; nothing the user typed is ever spliced into SQL. Event queries are compiled to
// SQLite and run in every event shard (rows, or partial aggregates per group); the head merges, applies person columns,
// HAVING, ORDER BY and LIMIT. `persons` queries run in the head. Limits: 10,000 result rows, 200,000 rows or groups per
// shard, 25 s.
import { QueryError } from './eventsql';
import type { PersonRef } from './query';

export const LIMITS = { resultRows: 10_000, shardRows: 200_000, personScan: 200_000, timeoutMs: 25_000 };
export type SqlShardSpec = { sql: string; params: SqlStorageValue[]; limit: number };
export interface SqlShard { sqlRows(s: SqlShardSpec): Promise<unknown[][]> }
export interface SqlHost {
  shards(from: number, to: number): Promise<SqlShard[]>;
  persons(cols: string[], where: unknown, limit: number): any[];
  resolve(dids: string[]): Map<string, PersonRef>;
}
/** Shard side: runs SQL the head compiled from an AST (a single SELECT over `events e`). */
export function runShardSql(db: SqlStorage, s: SqlShardSpec): unknown[][] {
  if (!/^SELECT /.test(s.sql) || s.sql.includes(';')) throw new QueryError('bad compiled query');
  return [...db.exec(s.sql + ' LIMIT ?', ...s.params, s.limit + 1).raw()];
}

// ---------------- lexer ----------------
type Tok = { t: 'num' | 'str' | 'id' | 'qid' | 'op' | 'end'; v: string; pos: number };
function lex(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue; }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) { const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!; out.push({ t: 'num', v: m[0], pos: start }); i += m[0].length; continue; }
    if (c === "'") { let v = ''; i++; for (;;) { if (i >= src.length) throw new QueryError('unterminated string'); if (src[i] === '\\' && i + 1 < src.length) { v += src[i + 1]; i += 2; continue; } if (src[i] === "'") { if (src[i + 1] === "'") { v += "'"; i += 2; continue; } i++; break; } v += src[i++]; } out.push({ t: 'str', v, pos: start }); continue; }
    if (c === '"' || c === '`') { const j = src.indexOf(c, i + 1); if (j < 0) throw new QueryError('unterminated identifier'); out.push({ t: 'qid', v: src.slice(i + 1, j), pos: start }); i = j + 1; continue; }
    if (/[A-Za-z_$]/.test(c)) { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!; out.push({ t: 'id', v: m[0], pos: start }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['!=', '<>', '<=', '>=', '||', '=='].includes(two)) { out.push({ t: 'op', v: two === '==' ? '=' : two === '<>' ? '!=' : two, pos: start }); i += 2; continue; }
    if ('(),.*+-/%=<>[]'.includes(c)) { out.push({ t: 'op', v: c, pos: start }); i++; continue; }
    throw new QueryError(`unexpected character "${c}" at ${i}`);
  }
  out.push({ t: 'end', v: '', pos: src.length });
  return out;
}

// ---------------- AST ----------------
export type Expr =
  | { k: 'lit'; v: number | string | null; dt?: boolean }
  | { k: 'col'; table: 'event' | 'person'; name: string; path?: string[] }
  | { k: 'fn'; name: string; args: Expr[]; distinct?: boolean; star?: boolean }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'not'; a: Expr } | { k: 'neg'; a: Expr }
  | { k: 'in'; a: Expr; list: Expr[]; not: boolean }
  | { k: 'isnull'; a: Expr; not: boolean }
  | { k: 'like'; a: Expr; b: Expr; not: boolean; ci: boolean }
  | { k: 'between'; a: Expr; lo: Expr; hi: Expr; not: boolean }
  | { k: 'ref'; i: number; alias?: string }; // ORDER BY / GROUP BY / HAVING position or alias of a select item
type Item = { e: Expr; name: string };
export type Select = { distinct: boolean; items: Item[] | '*'; from: 'events' | 'persons'; where: Expr | null; groupBy: Expr[]; having: Expr | null; orderBy: { e: Expr; desc: boolean }[]; limit: number; offset: number };

const AGGS = new Set(['count', 'sum', 'avg', 'min', 'max', 'uniq', 'uniqexact', 'countif', 'sumif']);
const FNS = new Set(['lower', 'upper', 'length', 'coalesce', 'ifnull', 'round', 'abs', 'concat', 'tostring', 'toint', 'tofloat', 'if', 'now', 'today', 'tostartofhour', 'tostartofday', 'tostartofweek', 'tostartofmonth', 'todate', 'todatetime', 'floor', 'ceil', 'tointervalday', 'tointervalhour', 'tointervalminute', 'tointervalweek', 'tointervalmonth', 'substring', 'trim', 'startswith', 'endswith', 'position', 'greatest', 'least']);
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3600_000, day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000, year: 365 * 86400_000 };
const KEYWORDS = new Set(['select', 'from', 'where', 'group', 'by', 'having', 'order', 'limit', 'offset', 'as', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'ilike', 'between', 'asc', 'desc', 'distinct', 'interval', 'true', 'false', 'join', 'union', 'with']);

export function parse(src: string): Select {
  if (src.length > 20_000) throw new QueryError('query too long');
  const toks = lex(src); let p = 0; let fromAlias: string | null = null;
  const peek = (o = 0) => toks[p + o];
  const kw = (w: string, o = 0) => peek(o).t === 'id' && peek(o).v.toLowerCase() === w;
  const op = (v: string) => peek().t === 'op' && peek().v === v;
  const eat = (v: string) => { if (op(v)) { p++; return true; } return false; };
  const eatKw = (w: string) => { if (kw(w)) { p++; return true; } return false; };
  const want = (v: string) => { if (!eat(v)) throw new QueryError(`expected "${v}" at ${peek().pos}`); };
  const wantKw = (w: string) => { if (!eatKw(w)) throw new QueryError(`expected ${w.toUpperCase()} at ${peek().pos}`); };
  const intLit = () => { const t = peek(); if (t.t !== 'num' || !/^\d+$/.test(t.v)) throw new QueryError('expected a whole number'); p++; return Number(t.v); };
  let depth = 0;
  const expr = (): Expr => { if (++depth > 64) throw new QueryError('expression too deep'); try { return orE(); } finally { depth--; } };
  const orE = (): Expr => { let a = andE(); while (eatKw('or')) a = { k: 'bin', op: 'OR', a, b: andE() }; return a; };
  const andE = (): Expr => { let a = notE(); while (eatKw('and')) a = { k: 'bin', op: 'AND', a, b: notE() }; return a; };
  const notE = (): Expr => eatKw('not') ? { k: 'not', a: notE() } : cmpE();
  const cmpE = (): Expr => {
    const a = addE();
    if (peek().t === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(peek().v)) { const o = toks[p++].v; return { k: 'bin', op: o, a, b: addE() }; }
    if (eatKw('is')) { const not = eatKw('not'); wantKw('null'); return { k: 'isnull', a, not }; }
    const not = kw('not') && (kw('in', 1) || kw('like', 1) || kw('ilike', 1) || kw('between', 1)) ? (p++, true) : false;
    if (eatKw('in')) { want('('); const list: Expr[] = []; do list.push(expr()); while (eat(',')); want(')'); if (list.length > 10_000) throw new QueryError('IN list too long'); return { k: 'in', a, list, not }; }
    if (kw('like') || kw('ilike')) { const ci = peek().v.toLowerCase() === 'ilike'; p++; return { k: 'like', a, b: addE(), not, ci }; }
    if (eatKw('between')) { const lo = addE(); wantKw('and'); return { k: 'between', a, lo, hi: addE(), not }; }
    if (not) throw new QueryError('expected IN, LIKE or BETWEEN after NOT');
    return a;
  };
  const addE = (): Expr => { let a = mulE(); while (peek().t === 'op' && ['+', '-', '||'].includes(peek().v)) { const o = toks[p++].v; a = o === '||' ? { k: 'fn', name: 'concat', args: [a, mulE()] } : { k: 'bin', op: o, a, b: mulE() }; } return a; };
  const mulE = (): Expr => { let a = unE(); while (peek().t === 'op' && ['*', '/', '%'].includes(peek().v)) { const o = toks[p++].v; a = { k: 'bin', op: o, a, b: unE() }; } return a; };
  const unE = (): Expr => { if (eat('-')) return { k: 'neg', a: unE() }; if (eat('+')) return unE(); return prim(); };
  const prim = (): Expr => {
    const t = peek();
    if (t.t === 'num') { p++; return { k: 'lit', v: Number(t.v) }; }
    if (t.t === 'str') { p++; return { k: 'lit', v: t.v }; }
    if (eat('(')) { if (kw('select')) throw new QueryError('subqueries are not supported'); const e = expr(); want(')'); return e; }
    if (eatKw('null')) return { k: 'lit', v: null };
    if (eatKw('true')) return { k: 'lit', v: 1 };
    if (eatKw('false')) return { k: 'lit', v: 0 };
    if (kw('interval')) { p++; const n = peek().t === 'str' ? Number(toks[p++].v) : intLit(); const u = peek(); if (u.t !== 'id') throw new QueryError('expected an interval unit'); p++; const unit = u.v.toLowerCase().replace(/s$/, ''); if (!UNIT_MS[unit]) throw new QueryError(`unknown interval unit ${u.v}`); return { k: 'lit', v: n * UNIT_MS[unit] }; }
    if (t.t === 'id' || t.t === 'qid') {
      p++;
      if (t.t === 'id' && op('(')) {
        const name = t.v.toLowerCase(); p++;
        if (!AGGS.has(name) && !FNS.has(name)) throw new QueryError(`unknown function ${t.v}`);
        if (eat(')')) return { k: 'fn', name, args: [], star: name === 'count' };
        if (op('*')) { p++; want(')'); if (name !== 'count') throw new QueryError('* only works in count(*)'); return { k: 'fn', name, args: [], star: true }; }
        const distinct = eatKw('distinct'); const args: Expr[] = []; do args.push(expr()); while (eat(',')); want(')');
        if (distinct && name !== 'count') throw new QueryError('DISTINCT only works in count(DISTINCT x)');
        if (name.startsWith('tointerval')) { const unit = name.slice(10); if (args[0].k !== 'lit' || typeof args[0].v !== 'number') throw new QueryError(`${t.v} needs a number`); return { k: 'lit', v: args[0].v * UNIT_MS[unit] }; }
        return { k: 'fn', name, args, distinct };
      }
      if (t.t === 'id' && KEYWORDS.has(t.v.toLowerCase())) throw new QueryError(`unexpected ${t.v.toUpperCase()} at ${t.pos}`);
      const parts = [t.v];
      for (;;) {
        if (eat('.')) { const n = peek(); if (n.t === 'id' || n.t === 'qid' || n.t === 'str' || n.t === 'num') { p++; parts.push(n.v); continue; } throw new QueryError('expected a name after "."'); }
        if (eat('[')) { const n = peek(); if (n.t !== 'str' && n.t !== 'num') throw new QueryError('expected a string key in [ ]'); p++; parts.push(n.v); want(']'); continue; }
        break;
      }
      return column(parts);
    }
    throw new QueryError(`unexpected "${t.v || 'end of query'}" at ${t.pos}`);
  };
  let from: 'events' | 'persons' = 'events';
  const column = (parts: string[]): Expr => {
    if (fromAlias && parts.length > 1 && parts[0] === fromAlias) parts = parts.slice(1);
    const [h, ...rest] = parts; const head = h.toLowerCase();
    if (from === 'events') {
      if (['event', 'distinct_id', 'timestamp', 'uuid'].includes(head) && !rest.length) return { k: 'col', table: 'event', name: head };
      if (head === 'properties') return { k: 'col', table: 'event', name: 'properties', path: rest.length ? rest : undefined };
      if (head === 'person_id' && !rest.length) return { k: 'col', table: 'person', name: 'id' };
      if (head === 'person') {
        if (!rest.length) throw new QueryError('use person.id or person.properties.<key>');
        const r0 = rest[0].toLowerCase();
        if ((r0 === 'id' || r0 === 'created_at') && rest.length === 1) return { k: 'col', table: 'person', name: r0 };
        if (r0 === 'properties') return { k: 'col', table: 'person', name: 'properties', path: rest.length > 1 ? rest.slice(1) : undefined };
      }
    } else {
      if (['id', 'created_at', 'is_identified'].includes(head) && !rest.length) return { k: 'col', table: 'person', name: head };
      if (head === 'properties') return { k: 'col', table: 'person', name: 'properties', path: rest.length ? rest : undefined };
    }
    if (parts.length === 1) return { k: 'ref', i: -1, alias: parts[0] };
    throw new QueryError(`unknown column ${parts.join('.')}`);
  };
  // FROM is parsed first so columns resolve against the right table.
  let fi = toks.findIndex((x, i) => x.t === 'id' && x.v.toLowerCase() === 'from' && toks.slice(0, i).filter(y => y.t === 'op' && y.v === '(').length === toks.slice(0, i).filter(y => y.t === 'op' && y.v === ')').length);
  if (fi < 0) throw new QueryError('expected FROM events or FROM persons');
  const ft = toks[fi + 1]; const tn = ft?.v?.toLowerCase();
  if (!ft || (tn !== 'events' && tn !== 'persons')) throw new QueryError('FROM must be events or persons');
  from = tn as 'events' | 'persons';
  const al = toks[fi + 2]; if (al?.t === 'id' && al.v.toLowerCase() === 'as') fromAlias = toks[fi + 3]?.v ?? null; else if (al?.t === 'id' && !KEYWORDS.has(al.v.toLowerCase())) fromAlias = al.v;

  wantKw('select');
  const distinct = eatKw('distinct');
  let items: Item[] | '*' = [];
  if (op('*')) { p++; items = '*'; }
  else do {
    const start = peek().pos; const e = expr(); const end = peek().pos;
    let name = src.slice(start, end).trim();
    if (eatKw('as')) { const n = peek(); if (n.t !== 'id' && n.t !== 'qid' && n.t !== 'str') throw new QueryError('expected an alias'); p++; name = n.v; }
    else if ((peek().t === 'id' && !KEYWORDS.has(peek().v.toLowerCase())) || peek().t === 'qid') name = toks[p++].v;
    (items as Item[]).push({ e, name });
  } while (eat(','));
  wantKw('from'); p++;
  if (eatKw('as')) p++; else if (peek().t === 'id' && !KEYWORDS.has(peek().v.toLowerCase())) p++;
  if (kw('join') || kw('inner') || kw('left')) throw new QueryError('JOIN is not supported; use person.properties.<key> on events');
  const sel: Select = { distinct, items, from, where: null, groupBy: [], having: null, orderBy: [], limit: 100, offset: 0 };
  const refOrExpr = (): Expr => {
    const e = expr();
    if (e.k === 'lit' && typeof e.v === 'number' && Number.isInteger(e.v) && items !== '*') { if (e.v < 1 || e.v > items.length) throw new QueryError('position out of range'); return { k: 'ref', i: e.v - 1 }; }
    if (e.k === 'col' && items !== '*') { /* alias lookup happens in plan() */ }
    return e;
  };
  if (eatKw('where')) sel.where = expr();
  if (eatKw('group')) { wantKw('by'); do sel.groupBy.push(refOrExpr()); while (eat(',')); }
  if (eatKw('having')) sel.having = expr();
  if (eatKw('order')) { wantKw('by'); do { const e = refOrExpr(); const desc = eatKw('desc') ? true : (eatKw('asc'), false); sel.orderBy.push({ e, desc }); } while (eat(',')); }
  if (eatKw('limit')) { sel.limit = intLit(); if (eat(',')) { sel.offset = sel.limit; sel.limit = intLit(); } }
  if (eatKw('offset')) sel.offset = intLit();
  if (peek().t !== 'end') throw new QueryError(`unexpected "${peek().v}" at ${peek().pos}`);
  sel.limit = Math.min(sel.limit, LIMITS.resultRows);
  if (sel.offset > 100_000) throw new QueryError('OFFSET too large');
  return sel;
}

// ---------------- analysis ----------------
const walk = (e: Expr, f: (x: Expr) => void) => {
  f(e);
  switch (e.k) {
    case 'fn': e.args.forEach(a => walk(a, f)); break;
    case 'bin': walk(e.a, f); walk(e.b, f); break;
    case 'not': case 'neg': case 'isnull': walk(e.a, f); break;
    case 'in': walk(e.a, f); e.list.forEach(a => walk(a, f)); break;
    case 'like': walk(e.a, f); walk(e.b, f); break;
    case 'between': walk(e.a, f); walk(e.lo, f); walk(e.hi, f); break;
  }
};
const isAgg = (e: Expr) => e.k === 'fn' && AGGS.has(e.name);
const hasAgg = (e: Expr) => { let y = false; walk(e, x => { if (isAgg(x)) y = true; }); return y; };
const refs = (e: Expr) => { const s = { event: false, person: false }; walk(e, x => { if (x.k === 'col') s[x.table] = true; }); return s; };
const same = (a: Expr, b: Expr) => JSON.stringify(a) === JSON.stringify(b);
const isDt = (e: Expr): boolean => {
  if (e.k === 'lit') return !!e.dt;
  if (e.k === 'col') return !e.path && (e.name === 'timestamp' || e.name === 'created_at');
  if (e.k === 'fn') return ['now', 'today', 'tostartofhour', 'tostartofday', 'tostartofweek', 'tostartofmonth', 'todate', 'todatetime'].includes(e.name) || ((e.name === 'min' || e.name === 'max' || e.name === 'coalesce' || e.name === 'greatest' || e.name === 'least') && e.args.length > 0 && isDt(e.args[0]));
  if (e.k === 'bin' && (e.op === '+' || e.op === '-')) return isDt(e.a) && !isDt(e.b);
  return false;
};
/** Compare a datetime with a string literal: the literal becomes epoch ms. */
function normalize(e: Expr): Expr {
  const fix = (x: Expr, other: Expr): Expr => { if (isDt(other) && x.k === 'lit' && typeof x.v === 'string') { const t = Date.parse(x.v); if (!Number.isFinite(t)) throw new QueryError(`not a date: ${x.v}`); return { k: 'lit', v: t, dt: true }; } return x; };
  switch (e.k) {
    case 'bin': { const a = normalize(e.a), b = normalize(e.b); return ['=', '!=', '<', '<=', '>', '>='].includes(e.op) ? { ...e, a: fix(a, b), b: fix(b, a) } : { ...e, a, b }; }
    case 'between': { const a = normalize(e.a); return { ...e, a, lo: fix(normalize(e.lo), a), hi: fix(normalize(e.hi), a) }; }
    case 'in': { const a = normalize(e.a); return { ...e, a, list: e.list.map(x => fix(normalize(x), a)) }; }
    case 'fn': return e.name === 'todatetime' && e.args[0]?.k === 'lit' && typeof e.args[0].v === 'string' ? (() => { const t = Date.parse(e.args[0].v as string); if (!Number.isFinite(t)) throw new QueryError('bad date'); return { k: 'lit', v: t, dt: true } as Expr; })() : { ...e, args: e.args.map(normalize) };
    case 'not': case 'neg': case 'isnull': return { ...e, a: normalize(e.a) } as Expr;
    case 'like': return { ...e, a: normalize(e.a), b: normalize(e.b) };
    default: return e;
  }
}

// ---------------- SQLite compile (event columns only) ----------------
type C = { sql: string; params: SqlStorageValue[] };
const jpath = (path: string[]) => '$' + path.map(k => '.' + JSON.stringify(k)).join('');
function compile(e: Expr, now: number): C {
  const c = (x: Expr) => compile(x, now);
  const join = (parts: C[], sep: string): C => ({ sql: parts.map(x => x.sql).join(sep), params: parts.flatMap(x => x.params) });
  switch (e.k) {
    case 'lit': return e.v === null ? { sql: 'NULL', params: [] } : { sql: '?', params: [e.v] };
    case 'col': {
      if (e.table !== 'event') throw new QueryError('internal: person column in shard SQL');
      if (e.name === 'properties') return e.path ? { sql: 'json_extract(e.properties, ?)', params: [jpath(e.path)] } : { sql: 'e.properties', params: [] };
      return { sql: 'e.' + e.name, params: [] };
    }
    case 'bin': {
      const a = c(e.a), b = c(e.b);
      if (e.op === 'AND' || e.op === 'OR') return { sql: `(${a.sql} ${e.op} ${b.sql})`, params: [...a.params, ...b.params] };
      if (e.op === '/') return { sql: `(CAST(${a.sql} AS REAL) / ${b.sql})`, params: [...a.params, ...b.params] };
      return { sql: `(${a.sql} ${e.op} ${b.sql})`, params: [...a.params, ...b.params] };
    }
    case 'not': { const a = c(e.a); return { sql: `(NOT ${a.sql})`, params: a.params }; }
    case 'neg': { const a = c(e.a); return { sql: `(-${a.sql})`, params: a.params }; }
    case 'isnull': { const a = c(e.a); return { sql: `(${a.sql} IS ${e.not ? 'NOT ' : ''}NULL)`, params: a.params }; }
    case 'in': { const a = c(e.a); const l = join(e.list.map(c), ', '); return { sql: `(${a.sql} ${e.not ? 'NOT ' : ''}IN (${l.sql}))`, params: [...a.params, ...l.params] }; }
    case 'like': { const a = c(e.a), b = c(e.b); return e.ci ? { sql: `(lower(${a.sql}) ${e.not ? 'NOT ' : ''}LIKE lower(${b.sql}))`, params: [...a.params, ...b.params] } : { sql: `(${a.sql} ${e.not ? 'NOT ' : ''}LIKE ${b.sql})`, params: [...a.params, ...b.params] }; }
    case 'between': { const a = c(e.a), lo = c(e.lo), hi = c(e.hi); return { sql: `(${a.sql} ${e.not ? 'NOT ' : ''}BETWEEN ${lo.sql} AND ${hi.sql})`, params: [...a.params, ...lo.params, ...hi.params] }; }
    case 'ref': throw new QueryError('internal: unresolved reference');
    case 'fn': {
      const A = e.args.map(c); const a0 = A[0];
      const one = (tpl: (s: string) => string) => { if (!a0) throw new QueryError(`${e.name} needs an argument`); return { sql: tpl(a0.sql), params: a0.params }; };
      switch (e.name) {
        case 'lower': case 'upper': case 'length': case 'abs': case 'trim': return one(s => `${e.name}(${s})`);
        case 'floor': return one(s => `CAST(floor(${s}) AS INTEGER)`);
        case 'ceil': return one(s => `CAST(ceil(${s}) AS INTEGER)`);
        case 'coalesce': case 'ifnull': return { sql: `coalesce(${join(A, ', ').sql}${A.length < 2 ? ', NULL' : ''})`, params: join(A, ', ').params };
        case 'greatest': return { sql: `max(${join(A, ', ').sql})`, params: join(A, ', ').params };
        case 'least': return { sql: `min(${join(A, ', ').sql})`, params: join(A, ', ').params };
        case 'round': return A.length > 1 ? { sql: `round(${a0.sql}, ${A[1].sql})`, params: [...a0.params, ...A[1].params] } : one(s => `round(${s})`);
        case 'concat': return { sql: '(' + A.map(x => `COALESCE(CAST(${x.sql} AS TEXT), '')`).join(' || ') + ')', params: A.flatMap(x => x.params) };
        case 'tostring': return one(s => `CAST(${s} AS TEXT)`);
        case 'toint': return one(s => `CAST(${s} AS INTEGER)`);
        case 'tofloat': return one(s => `CAST(${s} AS REAL)`);
        case 'if': if (A.length !== 3) throw new QueryError('if(cond, then, else)'); return { sql: `(CASE WHEN ${A[0].sql} THEN ${A[1].sql} ELSE ${A[2].sql} END)`, params: A.flatMap(x => x.params) };
        case 'now': return { sql: '?', params: [now] };
        case 'today': return { sql: '?', params: [Math.floor(now / 86400_000) * 86400_000] };
        case 'tostartofhour': return one(s => `((CAST(${s} AS INTEGER) / 3600000) * 3600000)`);
        case 'tostartofday': case 'todate': return one(s => `((CAST(${s} AS INTEGER) / 86400000) * 86400000)`);
        case 'tostartofweek': return { sql: `((CAST(${a0.sql} AS INTEGER) / 86400000) * 86400000 - CAST(strftime('%w', CAST(${a0.sql} AS INTEGER) / 1000, 'unixepoch') AS INTEGER) * 86400000)`, params: [...a0.params, ...a0.params] };
        case 'tostartofmonth': return one(s => `(CAST(strftime('%s', CAST(${s} AS INTEGER) / 1000, 'unixepoch', 'start of month') AS INTEGER) * 1000)`);
        case 'todatetime': throw new QueryError('toDateTime takes a string literal');
        case 'substring': return { sql: `substr(${join(A, ', ').sql})`, params: join(A, ', ').params };
        case 'startswith': return { sql: `(substr(${A[0].sql}, 1, length(${A[1].sql})) = ${A[1].sql})`, params: [...A[0].params, ...A[1].params, ...A[1].params] };
        case 'endswith': return { sql: `(substr(${A[0].sql}, -length(${A[1].sql})) = ${A[1].sql})`, params: [...A[0].params, ...A[1].params, ...A[1].params] };
        case 'position': return { sql: `instr(${A[0].sql}, ${A[1].sql})`, params: [...A[0].params, ...A[1].params] };
      }
      throw new QueryError(`${e.name} cannot be used here`);
    }
  }
}

// ---------------- JS evaluation (head) ----------------
type Ctx = { col?: (e: Extract<Expr, { k: 'col' }>) => unknown; agg?: (e: Expr) => unknown; key?: (e: Expr) => { hit: boolean; v?: unknown }; now: number };
const truthy = (v: unknown) => v !== null && v !== undefined && v !== 0 && v !== '0' && v !== false && v !== '';
const norm = (v: unknown): unknown => v === true ? 1 : v === false ? 0 : v === undefined ? null : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
export function cmp(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1; if (typeof b === 'number') return 1;
  const x = String(a), y = String(b); return x < y ? -1 : x > y ? 1 : 0;
}
const likeRe = (pat: string) => new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'is');
const startOfWeek = (t: number) => { const d = Math.floor(t / 86400_000) * 86400_000; return d - new Date(d).getUTCDay() * 86400_000; };
export function evalExpr(e: Expr, ctx: Ctx): unknown {
  if (ctx.key) { const k = ctx.key(e); if (k.hit) return k.v; }
  const ev = (x: Expr) => evalExpr(x, ctx);
  switch (e.k) {
    case 'lit': return e.v;
    case 'col': if (!ctx.col) throw new QueryError(`column ${e.path ? 'properties.' + e.path.join('.') : e.name} must be in GROUP BY or inside an aggregate`); return norm(ctx.col(e));
    case 'ref': throw new QueryError('internal: unresolved reference');
    case 'bin': {
      if (e.op === 'AND') { const a = ev(e.a); if (a !== null && !truthy(a)) return 0; const b = ev(e.b); if (b !== null && !truthy(b)) return 0; return a === null || b === null ? null : 1; }
      if (e.op === 'OR') { const a = ev(e.a); if (truthy(a)) return 1; const b = ev(e.b); if (truthy(b)) return 1; return a === null || b === null ? null : 0; }
      const a = ev(e.a), b = ev(e.b); if (a === null || b === null) return null;
      switch (e.op) {
        case '=': return cmp(a, b) === 0 ? 1 : 0; case '!=': return cmp(a, b) !== 0 ? 1 : 0;
        case '<': return cmp(a, b) < 0 ? 1 : 0; case '<=': return cmp(a, b) <= 0 ? 1 : 0; case '>': return cmp(a, b) > 0 ? 1 : 0; case '>=': return cmp(a, b) >= 0 ? 1 : 0;
        case '+': return Number(a) + Number(b); case '-': return Number(a) - Number(b); case '*': return Number(a) * Number(b);
        case '/': return Number(b) === 0 ? null : Number(a) / Number(b); case '%': return Number(b) === 0 ? null : Number(a) % Number(b);
      }
      throw new QueryError(`bad operator ${e.op}`);
    }
    case 'not': { const a = ev(e.a); return a === null ? null : truthy(a) ? 0 : 1; }
    case 'neg': { const a = ev(e.a); return a === null ? null : -Number(a); }
    case 'isnull': { const a = ev(e.a); return (a === null) !== e.not ? 1 : 0; }
    case 'in': { const a = ev(e.a); if (a === null) return null; const hit = e.list.some(x => cmp(a, ev(x)) === 0); return hit !== e.not ? 1 : 0; }
    case 'like': { const a = ev(e.a), b = ev(e.b); if (a === null || b === null) return null; return likeRe(String(b)).test(String(a)) !== e.not ? 1 : 0; }
    case 'between': { const a = ev(e.a), lo = ev(e.lo), hi = ev(e.hi); if (a === null || lo === null || hi === null) return null; return (cmp(a, lo) >= 0 && cmp(a, hi) <= 0) !== e.not ? 1 : 0; }
    case 'fn': {
      if (AGGS.has(e.name)) { if (!ctx.agg) throw new QueryError(`${e.name}() is not allowed here`); return ctx.agg(e); }
      const A = e.args.map(ev); const a = A[0];
      const num = (v: unknown) => v === null ? null : Number(v);
      switch (e.name) {
        case 'lower': return a === null ? null : String(a).toLowerCase();
        case 'upper': return a === null ? null : String(a).toUpperCase();
        case 'length': return a === null ? null : String(a).length;
        case 'trim': return a === null ? null : String(a).trim();
        case 'abs': return a === null ? null : Math.abs(Number(a));
        case 'floor': return a === null ? null : Math.floor(Number(a));
        case 'ceil': return a === null ? null : Math.ceil(Number(a));
        case 'coalesce': case 'ifnull': return A.find(v => v !== null) ?? null;
        case 'greatest': return A.some(v => v === null) ? null : A.reduce((x, y) => cmp(x, y) >= 0 ? x : y);
        case 'least': return A.some(v => v === null) ? null : A.reduce((x, y) => cmp(x, y) <= 0 ? x : y);
        case 'round': { if (a === null) return null; const d = Math.trunc(Number(A[1] ?? 0)); const f = 10 ** d; return Math.round(Number(a) * f) / f; }
        case 'concat': return A.map(v => v === null ? '' : String(v)).join('');
        case 'tostring': return a === null ? null : String(a);
        case 'toint': return a === null ? null : Math.trunc(Number(a)) || 0;
        case 'tofloat': return num(a);
        case 'if': return truthy(a) ? A[1] : A[2];
        case 'now': return ctx.now;
        case 'today': return Math.floor(ctx.now / 86400_000) * 86400_000;
        case 'tostartofhour': return a === null ? null : Math.floor(Number(a) / 3600_000) * 3600_000;
        case 'tostartofday': case 'todate': return a === null ? null : Math.floor(Number(a) / 86400_000) * 86400_000;
        case 'tostartofweek': return a === null ? null : startOfWeek(Number(a));
        case 'tostartofmonth': { if (a === null) return null; const d = new Date(Number(a)); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
        case 'substring': { if (a === null) return null; const s = String(a); const st = Number(A[1] ?? 1); const from = st > 0 ? st - 1 : Math.max(0, s.length + st); return A.length > 2 ? s.substr(from, Number(A[2])) : s.slice(from); }
        case 'startswith': return a === null || A[1] === null ? null : String(a).startsWith(String(A[1])) ? 1 : 0;
        case 'endswith': return a === null || A[1] === null ? null : String(a).endsWith(String(A[1])) ? 1 : 0;
        case 'position': return a === null || A[1] === null ? null : String(a).indexOf(String(A[1])) + 1;
      }
      throw new QueryError(`${e.name} cannot be used here`);
    }
  }
}

// ---------------- aggregates ----------------
type AggSpec = { e: Extract<Expr, { k: 'fn' }>; kind: 'count*' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'uniq' | 'uniqPerson' | 'countif' | 'sumif' };
type Acc = { n: number; s: number | null; m: unknown; set?: Set<string> };
const newAcc = (): Acc => ({ n: 0, s: null, m: null });
function aggKind(e: Extract<Expr, { k: 'fn' }>): AggSpec['kind'] {
  const personDistinct = (x: Expr | undefined) => x?.k === 'col' && x.table === 'person' && x.name === 'id';
  if (e.name === 'count' && e.star) return 'count*';
  if (e.name === 'count' && e.distinct) return personDistinct(e.args[0]) ? 'uniqPerson' : 'uniq';
  if (e.name === 'uniq' || e.name === 'uniqexact') return personDistinct(e.args[0]) ? 'uniqPerson' : 'uniq';
  if (e.name === 'count') return 'count';
  return e.name as AggSpec['kind'];
}
function checkAggArgs(a: AggSpec) {
  const need = a.kind === 'count*' ? 0 : a.kind === 'countif' ? 1 : a.kind === 'sumif' ? 2 : 1;
  if (a.e.args.length !== need) throw new QueryError(`${a.e.name}() takes ${need} argument${need === 1 ? '' : 's'}`);
  for (const x of a.e.args) { if (hasAgg(x)) throw new QueryError('aggregates cannot be nested'); }
  if (a.kind !== 'uniqPerson') for (const x of a.e.args) if (refs(x).person) throw new QueryError('aggregates over person columns: use count(DISTINCT person_id), or GROUP BY the person column');
}
/** Partial SQL per aggregate (shard side); merged in the head. */
function partialSql(a: AggSpec, now: number): C[] {
  if (a.kind === 'uniqPerson') return [];
  const x = a.e.args[0] ? compile(a.e.args[0], now) : null;
  switch (a.kind) {
    case 'count*': return [{ sql: 'COUNT(*)', params: [] }];
    case 'count': return [{ sql: `COUNT(${x!.sql})`, params: x!.params }];
    case 'countif': return [{ sql: `SUM(CASE WHEN ${x!.sql} THEN 1 ELSE 0 END)`, params: x!.params }];
    case 'sumif': { const c = compile(a.e.args[1], now); return [{ sql: `SUM(CASE WHEN ${c.sql} THEN ${x!.sql} END)`, params: [...c.params, ...x!.params] }]; }
    case 'sum': return [{ sql: `SUM(${x!.sql})`, params: x!.params }];
    case 'avg': return [{ sql: `SUM(${x!.sql})`, params: x!.params }, { sql: `COUNT(${x!.sql})`, params: x!.params }];
    case 'min': return [{ sql: `MIN(${x!.sql})`, params: x!.params }];
    case 'max': return [{ sql: `MAX(${x!.sql})`, params: x!.params }];
    case 'uniq': return [{ sql: `json_group_array(DISTINCT ${x!.sql})`, params: x!.params }];
  }
}
function mergePartial(a: AggSpec, acc: Acc, vals: unknown[], personKey: string | null) {
  const v0 = vals[0];
  switch (a.kind) {
    case 'count*': case 'count': case 'countif': acc.n += Number(v0 ?? 0); break;
    case 'sum': case 'sumif': if (v0 !== null && v0 !== undefined) acc.s = (acc.s ?? 0) + Number(v0); break;
    case 'avg': if (v0 !== null && v0 !== undefined) acc.s = (acc.s ?? 0) + Number(v0); acc.n += Number(vals[1] ?? 0); break;
    case 'min': if (v0 !== null && v0 !== undefined && (acc.m === null || cmp(v0, acc.m) < 0)) acc.m = v0; break;
    case 'max': if (v0 !== null && v0 !== undefined && (acc.m === null || cmp(v0, acc.m) > 0)) acc.m = v0; break;
    case 'uniq': { const s = acc.set ??= new Set(); for (const x of JSON.parse(String(v0 ?? '[]'))) if (x !== null) { s.add(JSON.stringify(x)); if (s.size > 5_000_000) throw new QueryError('too many distinct values'); } break; }
    case 'uniqPerson': if (personKey !== null) (acc.set ??= new Set()).add(personKey); break;
  }
}
function addRaw(a: AggSpec, acc: Acc, row: (x: Expr) => unknown) {
  const v = a.e.args[0] ? row(a.e.args[0]) : null;
  switch (a.kind) {
    case 'count*': acc.n++; break;
    case 'count': if (v !== null) acc.n++; break;
    case 'countif': if (truthy(v)) acc.n++; break;
    case 'sumif': if (truthy(row(a.e.args[1])) && v !== null) acc.s = (acc.s ?? 0) + Number(v); break;
    case 'sum': if (v !== null) acc.s = (acc.s ?? 0) + Number(v); break;
    case 'avg': if (v !== null) { acc.s = (acc.s ?? 0) + Number(v); acc.n++; } break;
    case 'min': if (v !== null && (acc.m === null || cmp(v, acc.m) < 0)) acc.m = v; break;
    case 'max': if (v !== null && (acc.m === null || cmp(v, acc.m) > 0)) acc.m = v; break;
    case 'uniq': case 'uniqPerson': if (v !== null) (acc.set ??= new Set()).add(JSON.stringify(v)); break;
  }
}
function finalAcc(a: AggSpec, acc: Acc): unknown {
  switch (a.kind) {
    case 'count*': case 'count': case 'countif': return acc.n;
    case 'sum': case 'sumif': return acc.s ?? (a.kind === 'sumif' ? 0 : null);
    case 'avg': return acc.n ? (acc.s ?? 0) / acc.n : null;
    case 'min': case 'max': return acc.m;
    case 'uniq': case 'uniqPerson': return acc.set?.size ?? 0;
  }
}

// ---------------- planner ----------------
export type SqlResult = { columns: string[]; types: string[]; results: unknown[][]; hasMore: boolean; limit: number; offset: number };
const conjuncts = (e: Expr | null): Expr[] => !e ? [] : e.k === 'bin' && e.op === 'AND' ? [...conjuncts(e.a), ...conjuncts(e.b)] : [e];
function personCol(e: Extract<Expr, { k: 'col' }>, ref: PersonRef | undefined, did?: string): unknown {
  if (!ref || !ref.uuid) return e.name === 'id' && did !== undefined ? null : null;
  if (e.name === 'id') return ref.uuid;
  if (e.name === 'created_at') return ref.created_at ?? null;
  if (e.name === 'properties') { let v: any = ref.props; if (!e.path) return JSON.stringify(v); for (const k of e.path) { if (v === null || typeof v !== 'object') return null; v = v[k]; } return v ?? null; }
  return null;
}
/** Replaces positions and aliases (`ORDER BY 2`, `GROUP BY day`) with the select item's expression. */
function subst(e: Expr, items: Item[], allowAlias: boolean): Expr {
  const r = (x: Expr) => subst(x, items, allowAlias);
  switch (e.k) {
    case 'ref': {
      if (e.i >= 0) return items[e.i].e;
      const it = allowAlias ? items.find(i => i.name === e.alias) : undefined;
      if (!it) throw new QueryError(`unknown column ${e.alias}`);
      return it.e;
    }
    case 'fn': return { ...e, args: e.args.map(r) };
    case 'bin': return { ...e, a: r(e.a), b: r(e.b) };
    case 'not': case 'neg': case 'isnull': return { ...e, a: r(e.a) } as Expr;
    case 'in': return { ...e, a: r(e.a), list: e.list.map(r) };
    case 'like': return { ...e, a: r(e.a), b: r(e.b) };
    case 'between': return { ...e, a: r(e.a), lo: r(e.lo), hi: r(e.hi) };
    default: return e;
  }
}

export async function runSql(host: SqlHost, src: string, qc: { timezone: string; now?: number }): Promise<SqlResult> {
  const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new QueryError(`query timed out after ${LIMITS.timeoutMs / 1000}s`)), LIMITS.timeoutMs));
  return Promise.race([execute(host, src, qc.now ?? Date.now()), timer]);
}

async function execute(host: SqlHost, src: string, now: number): Promise<SqlResult> {
  let sel = parse(src);
  const star: Item[] = sel.from === 'events'
    ? ['uuid', 'event', 'distinct_id', 'timestamp', 'properties'].map(n => ({ e: { k: 'col', table: 'event', name: n } as Expr, name: n }))
    : ['id', 'created_at', 'is_identified', 'properties'].map(n => ({ e: { k: 'col', table: 'person', name: n } as Expr, name: n }));
  let items = sel.items === '*' ? star : sel.items;
  items = items.map(i => ({ ...i, e: normalize(subst(i.e, [], false)) }));
  sel = { ...sel, where: sel.where ? normalize(subst(sel.where, items, false)) : null, having: sel.having ? normalize(subst(sel.having, items, true)) : null,
    groupBy: sel.groupBy.map(g => normalize(subst(g, items, true))), orderBy: sel.orderBy.map(o => ({ ...o, e: normalize(subst(o.e, items, true)) })) };
  if (sel.where && hasAgg(sel.where)) throw new QueryError('aggregates are not allowed in WHERE; use HAVING');
  const aggregate = sel.groupBy.length > 0 || items.some(i => hasAgg(i.e)) || (sel.having !== null) || sel.orderBy.some(o => hasAgg(o.e));
  for (const g of sel.groupBy) if (hasAgg(g)) throw new QueryError('aggregates are not allowed in GROUP BY');
  const types = items.map(i => isDt(i.e) ? 'DateTime' : 'String');
  const out = (rows: unknown[][], more: boolean): SqlResult => ({ columns: items.map(i => i.name), types, results: rows.map(r => r.map((v, k) => types[k] === 'DateTime' && typeof v === 'number' ? new Date(v).toISOString() : v)), hasMore: more, limit: sel.limit, offset: sel.offset });
  const aggs: AggSpec[] = [];
  const collect = (e: Expr) => walk(e, x => { if (isAgg(x) && !aggs.some(a => same(a.e, x))) { const a: AggSpec = { e: x as AggSpec['e'], kind: aggKind(x as AggSpec['e']) }; checkAggArgs(a); aggs.push(a); } });
  items.forEach(i => collect(i.e)); if (sel.having) collect(sel.having); sel.orderBy.forEach(o => collect(o.e));
  const finalize = (groups: Iterable<{ keys: unknown[]; accs: Acc[] }>) => {
    const rows: { vals: unknown[]; order: unknown[] }[] = [];
    for (const g of groups) {
      const ctx: Ctx = { now, agg: x => { const i = aggs.findIndex(a => same(a.e, x)); return finalAcc(aggs[i], g.accs[i]); }, key: x => { const i = sel.groupBy.findIndex(k => same(k, x)); return i >= 0 ? { hit: true, v: g.keys[i] } : { hit: false }; } };
      if (sel.having && !truthy(evalExpr(sel.having, ctx))) continue;
      rows.push({ vals: items.map(i => evalExpr(i.e, ctx)), order: sel.orderBy.map(o => evalExpr(o.e, ctx)) });
    }
    return rows;
  };
  const sortPage = (rows: { vals: unknown[]; order: unknown[] }[]) => {
    if (sel.orderBy.length) rows.sort((x, y) => { for (let i = 0; i < sel.orderBy.length; i++) { const c = cmp(x.order[i], y.order[i]); if (c) return sel.orderBy[i].desc ? -c : c; } return 0; });
    let vals = rows.map(r => r.vals);
    if (sel.distinct) { const seen = new Set<string>(); vals = vals.filter(v => { const k = JSON.stringify(v); if (seen.has(k)) return false; seen.add(k); return true; }); }
    const page = vals.slice(sel.offset, sel.offset + sel.limit);
    return out(page, vals.length > sel.offset + sel.limit);
  };

  // ----- persons: evaluated in the head -----
  if (sel.from === 'persons') {
    const all = host.persons([], null, LIMITS.personScan + 1);
    if (all.length > LIMITS.personScan) throw new QueryError(`persons queries scan at most ${LIMITS.personScan} persons`);
    const rowCtx = (p: any): Ctx => ({ now, col: c => c.name === 'id' ? p.uuid : c.name === 'created_at' ? p.created_at : c.name === 'is_identified' ? p.is_identified : (() => { let v: any = JSON.parse(p.properties || '{}'); if (!c.path) return JSON.stringify(v); for (const k of c.path) { if (v === null || typeof v !== 'object') return null; v = v[k]; } return v ?? null; })() });
    const match = all.filter(p => !sel.where || truthy(evalExpr(sel.where, rowCtx(p))));
    if (!aggregate) return sortPage(match.map(p => { const ctx = rowCtx(p); return { vals: items.map(i => evalExpr(i.e, ctx)), order: sel.orderBy.map(o => evalExpr(o.e, ctx)) }; }));
    const groups = new Map<string, { keys: unknown[]; accs: Acc[] }>();
    for (const p of match) {
      const ctx = rowCtx(p); const keys = sel.groupBy.map(k => evalExpr(k, ctx)); const kk = JSON.stringify(keys);
      let g = groups.get(kk); if (!g) groups.set(kk, g = { keys, accs: aggs.map(newAcc) });
      aggs.forEach((a, i) => addRaw(a, g!.accs[i], x => evalExpr(x, ctx)));
    }
    if (!sel.groupBy.length && !groups.size) groups.set('[]', { keys: [], accs: aggs.map(newAcc) });
    return sortPage(finalize(groups.values()));
  }

  // ----- events: shards + head -----
  const conds = sel.where ? conjuncts(sel.where) : [];
  const eventConds: Expr[] = [], personConds: Expr[] = [];
  for (const c of conds) { const r = refs(c); if (r.event && r.person) throw new QueryError('a WHERE condition cannot mix event and person columns; split it with AND'); (r.person ? personConds : eventConds).push(c); }
  // Time bounds from top-level timestamp conditions pick the shards.
  let from = -8.64e15, to = 8.64e15;
  for (const c of eventConds) if (c.k === 'bin' && c.a.k === 'col' && c.a.name === 'timestamp' && !c.a.path) {
    let v: unknown; try { v = evalExpr(c.b, { now }); } catch { continue; }
    if (typeof v !== 'number') continue;
    if (c.op === '>' || c.op === '>=') from = Math.max(from, v); if (c.op === '<' || c.op === '<=') to = Math.min(to, v); if (c.op === '=') { from = Math.max(from, v); to = Math.min(to, v); }
  } else if (c.k === 'between' && !c.not && c.a.k === 'col' && c.a.name === 'timestamp') { try { const lo = evalExpr(c.lo, { now }), hi = evalExpr(c.hi, { now }); if (typeof lo === 'number') from = Math.max(from, lo); if (typeof hi === 'number') to = Math.min(to, hi); } catch { /* ignore */ } }
  // Person conditions become a distinct-id list (persons evaluated in the head).
  let dids: string[] | null = null;
  if (personConds.length) {
    const all = host.persons([], null, LIMITS.personScan + 1);
    if (all.length > LIMITS.personScan) throw new QueryError(`person conditions scan at most ${LIMITS.personScan} persons`);
    dids = [];
    for (const p of all) {
      const ref: PersonRef = { pk: 'p' + p.id, uuid: p.uuid, props: JSON.parse(p.properties || '{}'), created_at: p.created_at };
      const ctx: Ctx = { now, col: c => personCol(c, ref) };
      if (personConds.every(c => truthy(evalExpr(c, ctx)))) dids.push(...String(p.dids ?? '').split('\u001f').filter(Boolean));
    }
    if (!dids.length) return out(aggregate && !sel.groupBy.length ? finalize([{ keys: [], accs: aggs.map(newAcc) }]).map(r => r.vals) : [], false);
  }
  const where: C[] = eventConds.map(c => compile(c, now));
  if (dids) where.push({ sql: 'e.distinct_id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(dids)] });
  const whereSql = where.length ? ' WHERE ' + where.map(w => w.sql).join(' AND ') : '';
  const whereParams = where.flatMap(w => w.params);
  const shards = await host.shards(from, to);
  const tooMany = () => new QueryError(`more than ${LIMITS.shardRows} rows or groups in one shard; add filters or GROUP BY fewer values`);

  if (!aggregate) {
    for (const i of items) { const r = refs(i.e); if (r.event && r.person) throw new QueryError(`column "${i.name}" mixes event and person columns`); }
    for (const o of sel.orderBy) if (refs(o.e).person) throw new QueryError('ORDER BY person columns is not supported on events; GROUP BY them instead');
    const evItems = items.map(i => refs(i.e).person ? null : compile(i.e, now));
    const ord = sel.orderBy.map(o => compile(o.e, now));
    const cols = [...evItems.map(c => c ?? { sql: 'NULL', params: [] }), ...ord, { sql: 'e.distinct_id', params: [] }];
    const sql = `SELECT ${sel.distinct ? 'DISTINCT ' : ''}${cols.map(c => c.sql).join(', ')} FROM events e${whereSql}${ord.length ? ' ORDER BY ' + ord.map((o, i) => `${items.length + i + 1} ${sel.orderBy[i].desc ? 'DESC' : 'ASC'}`).join(', ') : ''}`;
    const params = [...cols.flatMap(c => c.params), ...whereParams];
    const want = sel.offset + sel.limit + 1;
    const parts = await Promise.all(shards.map(s => s.sqlRows({ sql, params, limit: want })));
    const rows = parts.flat().map(r => ({ vals: r.slice(0, items.length), order: r.slice(items.length, items.length + ord.length), did: String(r[r.length - 1]) }));
    if (items.some(i => refs(i.e).person)) {
      const P = host.resolve([...new Set(rows.map(r => r.did))]);
      for (const r of rows) items.forEach((it, k) => { if (refs(it.e).person) r.vals[k] = evalExpr(it.e, { now, col: c => personCol(c, P.get(r.did), r.did) }); });
    }
    return sortPage(rows);
  }

  // Aggregates: shards group by the event-side keys (plus distinct_id when person keys or person counts are needed).
  for (const g of sel.groupBy) { const r = refs(g); if (r.event && r.person) throw new QueryError('a GROUP BY expression cannot mix event and person columns'); }
  const evKeys = sel.groupBy.map((g, i) => ({ g, i })).filter(x => !refs(x.g).person);
  const needDid = sel.groupBy.some(g => refs(g).person) || aggs.some(a => a.kind === 'uniqPerson');
  const partials = aggs.map(a => partialSql(a, now));
  const keySql = evKeys.map(k => compile(k.g, now));
  const cols = [...keySql, ...(needDid ? [{ sql: 'e.distinct_id', params: [] as SqlStorageValue[] }] : []), ...partials.flat()];
  if (!cols.length) cols.push({ sql: 'COUNT(*)', params: [] });
  const groupBy = [...keySql.map((_, i) => String(i + 1)), ...(needDid ? [String(keySql.length + 1)] : [])];
  const sql = `SELECT ${cols.map(c => c.sql).join(', ')} FROM events e${whereSql}${groupBy.length ? ' GROUP BY ' + groupBy.join(', ') : ''}`;
  const params = [...cols.flatMap(c => c.params), ...whereParams];
  const parts = await Promise.all(shards.map(s => s.sqlRows({ sql, params, limit: LIMITS.shardRows })));
  if (parts.some(p => p.length > LIMITS.shardRows)) throw tooMany();
  const rows = parts.flat();
  const P = needDid ? host.resolve([...new Set(rows.map(r => String(r[keySql.length])))]) : null;
  const groups = new Map<string, { keys: unknown[]; accs: Acc[] }>();
  for (const r of rows) {
    const did = needDid ? String(r[keySql.length]) : null;
    const ref = did !== null ? P!.get(did) : undefined;
    const keys: unknown[] = new Array(sel.groupBy.length);
    evKeys.forEach((k, j) => { keys[k.i] = r[j]; });
    sel.groupBy.forEach((g, i) => { if (refs(g).person) keys[i] = evalExpr(g, { now, col: c => personCol(c, ref, did ?? undefined) }); });
    const kk = JSON.stringify(keys);
    let g = groups.get(kk); if (!g) { if (groups.size >= LIMITS.shardRows * 2) throw tooMany(); groups.set(kk, g = { keys, accs: aggs.map(newAcc) }); }
    let off = keySql.length + (needDid ? 1 : 0);
    aggs.forEach((a, i) => { const n = partials[i].length; mergePartial(a, g!.accs[i], r.slice(off, off + n), did === null ? null : (ref?.pk ?? 'd' + did)); off += n; });
  }
  if (!sel.groupBy.length && !groups.size) groups.set('[]', { keys: [], accs: aggs.map(newAcc) });
  return sortPage(finalize(groups.values()));
}
