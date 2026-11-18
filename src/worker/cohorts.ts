// Cohorts (design.md "Cohorts"): static lists of persons, or dynamic definitions over person properties, behaviour
// (performed an event or action N times in the last T) and other cohorts, in PostHog's PropertyGroup shape:
//   { properties: { type: 'OR', values: [ { type: 'AND', values: [criterion, …] }, … ] } }
// Criteria: { type: 'person', key, value, operator, negation? }
//           { type: 'behavioral', key: <event name or action id>, event_type: 'events' | 'actions',
//             value: 'performed_event' | 'performed_event_multiple', time_value, time_interval, operator?, operator_value?, negation? }
//           { type: 'cohort', key: 'id', value: <cohort id>, negation? }
import { QueryError, validateFilters, matchPerson } from './eventsql';

export type Criterion = { type: 'person' | 'behavioral' | 'cohort'; key: string; value?: unknown; operator?: string; negation?: boolean;
  event_type?: 'events' | 'actions'; time_value?: number; time_interval?: string; operator_value?: number; event_filters?: unknown[] };
export type Group = { type: 'AND' | 'OR'; values: (Group | Criterion)[] };
const isGroup = (x: any): x is Group => x && (x.type === 'AND' || x.type === 'OR') && Array.isArray(x.values);
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

export function cleanGroup(g: any, depth = 0): Group {
  if (depth > 6) throw new QueryError('cohort filters nest too deeply');
  if (!isGroup(g)) throw new QueryError('cohort filters must be {type: AND|OR, values: [...]}');
  if (g.values.length > 50) throw new QueryError('at most 50 criteria per group');
  return { type: g.type, values: g.values.map((v: any) => isGroup(v) ? cleanGroup(v, depth + 1) : cleanCriterion(v)) };
}
function cleanCriterion(c: any): Criterion {
  if (!c || typeof c !== 'object') throw new QueryError('bad cohort criterion');
  const negation = !!c.negation;
  if (c.type === 'person') { validateFilters([{ key: c.key, value: c.value, operator: c.operator ?? 'exact', type: 'person' }]); return { type: 'person', key: String(c.key), value: c.value, operator: c.operator ?? 'exact', negation }; }
  if (c.type === 'cohort') { const id = Number(c.value); if (!Number.isInteger(id)) throw new QueryError('cohort criterion needs a cohort id'); return { type: 'cohort', key: 'id', value: id, negation }; }
  if (c.type === 'behavioral') {
    if (!['performed_event', 'performed_event_multiple'].includes(c.value)) throw new QueryError('behavioral criteria support performed_event and performed_event_multiple');
    const event_type = c.event_type === 'actions' ? 'actions' : 'events';
    if (!c.key && c.key !== 0) throw new QueryError('behavioral criterion needs an event or action');
    const tv = Math.max(1, Math.min(Number(c.time_value) || 30, 3650)); const ti = UNIT_DAYS[c.time_interval] ? c.time_interval : 'day';
    const out: Criterion = { type: 'behavioral', key: String(c.key), value: c.value, event_type, time_value: tv, time_interval: ti, negation };
    if (Array.isArray(c.event_filters)) { validateFilters(c.event_filters); out.event_filters = c.event_filters; }
    if (c.value === 'performed_event_multiple') {
      out.operator = ['gte', 'lte', 'exact', 'gt', 'lt'].includes(c.operator) ? c.operator : 'gte';
      out.operator_value = Math.max(0, Math.floor(Number(c.operator_value) || 1));
    }
    return out;
  }
  throw new QueryError('criterion type must be person, behavioral or cohort');
}
export function criteria(g: Group): Criterion[] { return g.values.flatMap(v => isGroup(v) ? criteria(v) : [v]); }
export const windowMs = (c: Criterion) => (c.time_value ?? 30) * (UNIT_DAYS[c.time_interval ?? 'day'] ?? 1) * 86400_000;
/** Stable key of a behavioral criterion, for caching its per-person counts. */
export const behaviorKey = (c: Criterion) => JSON.stringify([c.event_type, c.key, c.time_value, c.time_interval, c.event_filters ?? []]);
export function countOk(c: Criterion, n: number) {
  if (c.value === 'performed_event') return n > 0;
  const v = c.operator_value ?? 1;
  switch (c.operator) { case 'lte': return n <= v; case 'lt': return n < v; case 'exact': return n === v; case 'gt': return n > v; default: return n >= v; }
}
export type EvalCtx = { props: Record<string, unknown>; behavior: (c: Criterion) => number; cohort: (id: number) => boolean };
export function evalGroup(g: Group, ctx: EvalCtx): boolean {
  if (!g.values.length) return g.type === 'AND' ? false : false;
  const one = (v: Group | Criterion): boolean => {
    if (isGroup(v)) return evalGroup(v, ctx);
    let r: boolean;
    if (v.type === 'person') r = matchPerson({ key: v.key, value: v.value, operator: v.operator }, ctx.props);
    else if (v.type === 'cohort') r = ctx.cohort(Number(v.value));
    else r = countOk(v, ctx.behavior(v));
    return v.negation ? !r : r;
  };
  return g.type === 'AND' ? g.values.every(one) : g.values.some(one);
}
/** True when the definition uses only person properties (directly or through property-only cohorts). */
export function propertyOnly(g: Group, lookup: (id: number) => Group | null, seen = new Set<number>()): boolean {
  return criteria(g).every(c => c.type === 'person' || (c.type === 'cohort' && !seen.has(Number(c.value)) && (() => {
    const sub = lookup(Number(c.value)); if (!sub) return false; seen.add(Number(c.value)); return propertyOnly(sub, lookup, seen);
  })()));
}
/** Flag-style PropertyGroup for posthog-node local evaluation (only property-only cohorts are sent). */
export function toFlagGroup(g: Group): unknown {
  return { type: g.type, values: g.values.map(v => isGroup(v) ? toFlagGroup(v) : v.type === 'cohort' ? { key: 'id', type: 'cohort', value: v.value, negation: !!v.negation }
    : { key: v.key, type: 'person', value: v.value, operator: v.operator ?? 'exact', negation: !!v.negation }) };
}
