// Surveys (design.md "Surveys"): definitions in the head store, served to posthog-js from /api/surveys/?token=; results
// from the SDK's `survey shown` / `survey dismissed` / `survey sent` events (protocol.md "Surveys").
import type { Engine } from './query';
import type { EventRow } from './eventsql';
import { QueryError } from './eventsql';

const TYPES = new Set(['popover', 'api', 'widget', 'external_survey']);
const QTYPES = new Set(['open', 'link', 'rating', 'single_choice', 'multiple_choice']);
const str = (v: unknown, max = 2000) => typeof v === 'string' ? v.slice(0, max) : undefined;

/** Cleans a survey body from the owner API into the stored shape (posthog-js Survey fields). */
export function cleanSurvey(b: any, prev?: any) {
  const name = str(b.name, 200) ?? prev?.name; if (!name || !name.trim()) throw new QueryError('a survey needs a name');
  const type = b.type ?? prev?.type ?? 'popover'; if (!TYPES.has(type)) throw new QueryError('type must be popover, api, widget or external_survey');
  const qs = b.questions ?? prev?.questions ?? [];
  if (!Array.isArray(qs) || !qs.length || qs.length > 20) throw new QueryError('a survey needs 1-20 questions');
  const questions = qs.map((q: any) => {
    if (!q || !QTYPES.has(q.type)) throw new QueryError('question type must be open, link, rating, single_choice or multiple_choice');
    if (!str(q.question, 1000)) throw new QueryError('every question needs text');
    const out: any = { id: str(q.id, 64) || crypto.randomUUID(), type: q.type, question: q.question, description: str(q.description) ?? '', optional: !!q.optional, buttonText: str(q.buttonText, 100) };
    if (q.type === 'rating') { out.display = q.display === 'emoji' ? 'emoji' : 'number'; out.scale = [2, 3, 5, 7, 10].includes(Number(q.scale)) ? Number(q.scale) : 5; out.lowerBoundLabel = str(q.lowerBoundLabel, 100) ?? ''; out.upperBoundLabel = str(q.upperBoundLabel, 100) ?? ''; }
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      if (!Array.isArray(q.choices) || q.choices.length < 2) throw new QueryError('choice questions need at least 2 choices');
      out.choices = q.choices.map((c: unknown) => String(c).slice(0, 200)); out.hasOpenChoice = !!q.hasOpenChoice; out.shuffleOptions = !!q.shuffleOptions;
    }
    if (q.type === 'link') out.link = str(q.link, 2000) ?? '';
    if (q.branching && typeof q.branching === 'object') out.branching = q.branching;
    return out;
  });
  const appearance = { whiteLabel: true, ...(prev?.appearance ?? {}), ...(b.appearance && typeof b.appearance === 'object' ? b.appearance : {}) };
  const conditions = b.conditions !== undefined ? cleanConditions(b.conditions) : prev?.conditions ?? null;
  const tff = b.targeting_flag_filters !== undefined ? cleanTargeting(b.targeting_flag_filters) : prev?.targeting_flag_filters ?? null;
  const intOr = (v: unknown, lo: number, hi: number) => v === null || v === undefined || v === '' ? null : (() => { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw new QueryError(`must be ${lo}-${hi}`); return n; })();
  const iteration_count = b.iteration_count !== undefined ? intOr(b.iteration_count, 1, 500) : prev?.iteration_count ?? null;
  const iteration_frequency_days = b.iteration_frequency_days !== undefined ? intOr(b.iteration_frequency_days, 1, 3650) : prev?.iteration_frequency_days ?? null;
  if (iteration_count && !iteration_frequency_days) throw new QueryError('iteration_frequency_days is required with iteration_count');
  const schedule = b.schedule !== undefined ? (['once', 'recurring', 'always'].includes(b.schedule) ? b.schedule : 'once') : prev?.schedule ?? (iteration_count ? 'recurring' : 'once');
  return { name: name.trim(), description: str(b.description) ?? prev?.description ?? '', type, questions, appearance, conditions,
    linked_flag_key: b.linked_flag_key !== undefined ? (str(b.linked_flag_key, 200) || null) : prev?.linked_flag_key ?? null,
    enable_partial_responses: b.enable_partial_responses !== undefined ? !!b.enable_partial_responses : !!prev?.enable_partial_responses,
    targeting_flag_filters: tff, iteration_count, iteration_frequency_days: iteration_count ? iteration_frequency_days : null, schedule: iteration_count ? 'recurring' : schedule };
}

const MATCH = new Set(['exact', 'is_not', 'icontains', 'not_icontains', 'regex', 'not_regex']);
/** Display conditions evaluated by posthog-js (URL, selector, device types, wait period, linked flag variant, event and action triggers). */
export function cleanConditions(c: any) {
  if (!c || typeof c !== 'object') return null;
  const out: any = {};
  if (typeof c.url === 'string' && c.url) { out.url = c.url.slice(0, 2000); out.urlMatchType = MATCH.has(c.urlMatchType) ? c.urlMatchType : 'icontains'; if (out.urlMatchType.includes('regex')) { try { new RegExp(out.url); } catch { throw new QueryError('url is not a valid regex'); } } }
  if (typeof c.selector === 'string' && c.selector) out.selector = c.selector.slice(0, 1000);
  if (Array.isArray(c.deviceTypes) && c.deviceTypes.length) { out.deviceTypes = c.deviceTypes.filter((d: unknown) => ['Desktop', 'Mobile', 'Tablet'].includes(String(d))); out.deviceTypesMatchType = MATCH.has(c.deviceTypesMatchType) ? c.deviceTypesMatchType : 'icontains'; }
  if (c.seenSurveyWaitPeriodInDays !== undefined && c.seenSurveyWaitPeriodInDays !== null && c.seenSurveyWaitPeriodInDays !== '') { const n = Number(c.seenSurveyWaitPeriodInDays); if (!(n >= 0 && n <= 3650)) throw new QueryError('seenSurveyWaitPeriodInDays must be 0-3650'); out.seenSurveyWaitPeriodInDays = n; }
  if (typeof c.linkedFlagVariant === 'string' && c.linkedFlagVariant) out.linkedFlagVariant = c.linkedFlagVariant.slice(0, 200);
  const names = (x: any) => Array.isArray(x?.values) ? x.values.filter((v: any) => v && v.name).map((v: any) => ({ name: String(v.name).slice(0, 400) })) : [];
  if (names(c.events).length) out.events = { values: names(c.events), repeatedActivation: !!c.events.repeatedActivation };
  if (names(c.cancelEvents).length) out.cancelEvents = { values: names(c.cancelEvents) };
  if (Array.isArray(c.actions?.values) && c.actions.values.length) out.actions = { values: c.actions.values.filter((v: any) => Number.isInteger(Number(v?.id))).map((v: any) => ({ id: Number(v.id) })) };
  return Object.keys(out).length ? out : null;
}
/** Person/cohort targeting, stored as a feature flag's filters (one or more condition groups). */
export function cleanTargeting(f: any) {
  if (!f) return null;
  if (typeof f !== 'object' || !Array.isArray(f.groups) || !f.groups.length) throw new QueryError('targeting_flag_filters needs {groups: [{properties, rollout_percentage}]}');
  return { groups: f.groups.slice(0, 20).map((g: any) => ({ properties: Array.isArray(g?.properties) ? g.properties : [], rollout_percentage: g?.rollout_percentage ?? 100, variant: null })) };
}
/** Current iteration of a recurring survey: 1 + whole periods since launch, capped at the iteration count. */
export function surveyIteration(s: { start_date: number | null; iteration_count?: number | null; iteration_frequency_days?: number | null }, now: number): { n: number; start: number } | null {
  if (!s.iteration_count || !s.iteration_frequency_days || !s.start_date) return null;
  const per = s.iteration_frequency_days * 86400_000;
  const n = Math.min(s.iteration_count, Math.floor(Math.max(0, now - s.start_date) / per) + 1);
  return { n, start: s.start_date + (n - 1) * per };
}
/** The internal targeting flag: people who have not responded to or dismissed this survey (this iteration). */
export function internalFlagFilters(id: string, iteration: number | null) {
  const suffix = iteration && iteration > 0 ? `/${iteration}` : '';
  return { groups: [{ variant: null, rollout_percentage: 100, properties: [
    { key: `$survey_dismissed/${id}${suffix}`, type: 'person', value: 'is_not_set', operator: 'is_not_set' },
    { key: `$survey_responded/${id}${suffix}`, type: 'person', value: 'is_not_set', operator: 'is_not_set' },
  ] }] };
}

/** The posthog-js view of a survey (GET /api/surveys/?token=); `action` fills action triggers with their steps. */
export function publicSurvey(s: any, now = Date.now(), action?: (id: number) => { id: number; name: string; steps: unknown[] } | null) {
  const it = surveyIteration(s, now);
  let conditions = s.conditions;
  if (conditions?.actions?.values && action) conditions = { ...conditions, actions: { values: conditions.actions.values.map((v: any) => { const a = action(Number(v.id)); return a ? { id: a.id, name: a.name, steps: a.steps } : null; }).filter(Boolean) } };
  return { id: s.id, name: s.name, description: s.description, type: s.type, questions: s.questions, appearance: s.appearance, conditions,
    start_date: s.start_date ? new Date(s.start_date).toISOString() : null, end_date: s.end_date ? new Date(s.end_date).toISOString() : null,
    linked_flag_key: s.linked_flag_key, targeting_flag_key: s.targeting_flag_key ?? null, internal_targeting_flag_key: s.internal_targeting_flag_key ?? null,
    feature_flag_keys: [{ key: 'flag', value: s.linked_flag_key ?? undefined }, { key: 'targeting_flag', value: s.targeting_flag_key ?? undefined }, { key: 'internal_targeting_flag', value: s.internal_targeting_flag_key ?? undefined }],
    current_iteration: it?.n ?? null, current_iteration_start_date: it ? new Date(it.start).toISOString() : null, schedule: s.schedule ?? 'once', enable_partial_responses: s.enable_partial_responses,
    targeting_flag_filters: s.targeting_flag_filters ?? null, iteration_count: s.iteration_count ?? null, iteration_frequency_days: s.iteration_frequency_days ?? null };
}

const PAGE = 5000;
/** Every event of one type for the survey, page by page from each shard (memory is bounded by the page size). */
async function scan(en: Engine, event: string, properties: any[], cb: (r: EventRow) => void) {
  for (const sh of await en.shards(-8.64e15, 8.64e15)) {
    let cursor: [number, string] | null = null;
    for (;;) {
      const rows = await sh.events({ event, properties, cursor, limit: PAGE });
      for (const r of rows) cb(r);
      if (rows.length < PAGE) break;
      const l = rows[rows.length - 1]; cursor = [l.timestamp, l.uuid];
    }
  }
}
type Sub = { did: string; ts: number; completed: boolean; answers: Map<string, { v: unknown; ts: number }>; iteration: number | null };
/**
 * Aggregates the survey's events: shown / dismissed / abandoned counts and per-question answers. Partial responses
 * (`enable_partial_responses`) send one `survey sent` per answered question with the same `$survey_submission_id`;
 * they are merged per submission, keeping every question's latest non-empty answer (design.md "Surveys"). Events are read
 * in pages, so there is no row cap; `iteration` limits the results to one iteration of a recurring survey.
 */
export async function surveyResults(en: Engine, s: any, opts: { iteration?: number | null } = {}) {
  const filter: any[] = [{ key: '$survey_id', value: [s.id], operator: 'exact' }];
  if (opts.iteration) filter.push({ key: '$survey_iteration', value: [String(opts.iteration)], operator: 'exact' });
  const count = async (event: string) => { const dids = new Set<string>(); let n = 0; await scan(en, event, filter, r => { n++; dids.add(r.distinct_id); }); return { n, dids }; };
  const [shown, dismissed, abandoned] = [await count('survey shown'), await count('survey dismissed'), await count('survey abandoned')];
  const subs = new Map<string, Sub>();
  const iterations = new Map<number, number>();
  const answerKey = (p: any, q: any, i: number) => { const v = p[`$survey_response_${q.id}`] ?? (i === 0 ? p.$survey_response : p[`$survey_response_${i}`]); return v === '' ? undefined : v; };
  await scan(en, 'survey sent', filter, r => {
    let p: any; try { p = JSON.parse(r.properties); } catch { return; }
    const key = String(p.$survey_submission_id ?? r.uuid);
    let sub = subs.get(key); if (!sub) subs.set(key, sub = { did: r.distinct_id, ts: r.timestamp, completed: false, answers: new Map(), iteration: p.$survey_iteration != null ? Number(p.$survey_iteration) : null });
    if (r.timestamp > sub.ts) { sub.ts = r.timestamp; sub.did = r.distinct_id; }
    if (p.$survey_completed !== false) sub.completed = true;
    s.questions.forEach((q: any, i: number) => { const v = answerKey(p, q, i); if (v === undefined || v === null) return; const cur = sub!.answers.get(q.id); if (!cur || r.timestamp >= cur.ts) sub!.answers.set(q.id, { v, ts: r.timestamp }); });
  });
  for (const x of subs.values()) if (x.iteration) iterations.set(x.iteration, (iterations.get(x.iteration) ?? 0) + 1);
  const responses = [...subs.values()].sort((a, b) => a.ts - b.ts);
  const people = en.resolve([...new Set([...shown.dids, ...dismissed.dids, ...abandoned.dids, ...responses.map(r => r.did)])]);
  const pk = (d: string) => people.get(d)?.pk ?? 'd' + d;
  const uniq = (dids: Iterable<string>) => new Set([...dids].map(pk)).size;
  const responders = uniq(responses.map(r => r.did));
  const questions = s.questions.map((q: any) => {
    const vals = responses.map(x => ({ v: x.answers.get(q.id)?.v, x })).filter(a => a.v !== undefined && a.v !== null && a.v !== '');
    const base = { id: q.id, type: q.type, question: q.question, responses: vals.length };
    if (q.type === 'rating') {
      const dist = new Array(q.scale === 10 ? 11 : q.scale).fill(0); const off = q.scale === 10 ? 0 : 1;
      for (const a of vals) { const n = Number(a.v); if (Number.isInteger(n) && n - off >= 0 && n - off < dist.length) dist[n - off]++; }
      const out: any = { ...base, scale: q.scale, distribution: dist.map((count, k) => ({ value: k + off, count })), average: vals.length ? vals.reduce((t, a) => t + Number(a.v), 0) / vals.length : null };
      if (q.scale === 10 && vals.length) { const pro = vals.filter(a => Number(a.v) >= 9).length, det = vals.filter(a => Number(a.v) <= 6).length; out.nps = Math.round(((pro - det) / vals.length) * 100); out.promoters = pro; out.detractors = det; out.passives = vals.length - pro - det; }
      return out;
    }
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      const counts = new Map<string, number>(q.choices.map((c: string) => [c, 0]));
      for (const a of vals) for (const c of Array.isArray(a.v) ? a.v : [a.v]) counts.set(String(c), (counts.get(String(c)) ?? 0) + 1);
      return { ...base, choices: [...counts].map(([choice, count]) => ({ choice, count })) };
    }
    return { ...base, latest: vals.slice(-100).reverse().map(a => { const ref = people.get(a.x.did); return { value: String(a.v), timestamp: new Date(a.x.ts).toISOString(), distinct_id: a.x.did, completed: a.x.completed, person: ref?.uuid ? { id: ref.uuid, name: (ref.props.email ?? ref.props.name ?? a.x.did) as string } : null }; }) };
  });
  const completed = responses.filter(x => x.completed).length;
  return { shown: { events: shown.n, persons: uniq(shown.dids) }, dismissed: { events: dismissed.n, persons: uniq(dismissed.dids) }, abandoned: { events: abandoned.n, persons: uniq(abandoned.dids) },
    sent: { responses: responses.length, completed, partial: responses.length - completed, persons: responders },
    response_rate: uniq(shown.dids) ? responders / uniq(shown.dids) : null, iteration: opts.iteration ?? null,
    iterations: [...iterations].sort((a, b) => a[0] - b[0]).map(([iteration, responses]) => ({ iteration, responses })), questions };
}
