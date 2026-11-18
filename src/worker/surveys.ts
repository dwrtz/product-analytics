// Surveys (design.md "Surveys"): definitions in the head store, served to posthog-js from /api/surveys/?token=; results
// from the SDK's `survey shown` / `survey dismissed` / `survey sent` events (protocol.md "Surveys").
import type { Engine } from './query';
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
  const conditions = b.conditions !== undefined ? (b.conditions && typeof b.conditions === 'object' ? b.conditions : null) : prev?.conditions ?? null;
  return { name: name.trim(), description: str(b.description) ?? prev?.description ?? '', type, questions, appearance, conditions,
    linked_flag_key: b.linked_flag_key !== undefined ? (str(b.linked_flag_key, 200) || null) : prev?.linked_flag_key ?? null,
    enable_partial_responses: b.enable_partial_responses !== undefined ? !!b.enable_partial_responses : !!prev?.enable_partial_responses };
}

/** The posthog-js view of a survey (GET /api/surveys/?token=). */
export function publicSurvey(s: any) {
  return { id: s.id, name: s.name, description: s.description, type: s.type, questions: s.questions, appearance: s.appearance, conditions: s.conditions,
    start_date: s.start_date ? new Date(s.start_date).toISOString() : null, end_date: s.end_date ? new Date(s.end_date).toISOString() : null,
    linked_flag_key: s.linked_flag_key, targeting_flag_key: null, internal_targeting_flag_key: null, feature_flag_keys: [],
    current_iteration: null, current_iteration_start_date: null, schedule: 'once', enable_partial_responses: s.enable_partial_responses };
}

/** Aggregates the survey's events: funnel counts and per-question answers (latest submission wins for partial responses). */
export async function surveyResults(en: Engine, s: any) {
  const filter = [{ key: '$survey_id', value: [s.id], operator: 'exact' }];
  const rows = async (event: string) => (await Promise.all((await en.shards(-8.64e15, 8.64e15)).map(sh => sh.events({ event, properties: filter, limit: 50000 })))).flat();
  const [shown, dismissed, sent] = await Promise.all([rows('survey shown'), rows('survey dismissed'), rows('survey sent')]);
  const people = en.resolve([...new Set([...shown, ...dismissed, ...sent].map(r => r.distinct_id))]);
  const pk = (d: string) => people.get(d)?.pk ?? 'd' + d;
  const uniq = (rs: { distinct_id: string }[]) => new Set(rs.map(r => pk(r.distinct_id))).size;
  // One response per submission id (partial responses send several events), else per event.
  const latest = new Map<string, any>();
  for (const r of sent.sort((a, b) => a.timestamp - b.timestamp)) {
    const p = JSON.parse(r.properties);
    latest.set(String(p.$survey_submission_id ?? r.uuid), { p, r });
  }
  const responses = [...latest.values()];
  const completed = responses.filter(x => x.p.$survey_completed !== false);
  const answer = (p: any, q: any, i: number) => p[`$survey_response_${q.id}`] ?? (i === 0 ? p.$survey_response : p[`$survey_response_${i}`]);
  const questions = s.questions.map((q: any, i: number) => {
    const vals = responses.map(x => ({ v: answer(x.p, q, i), x })).filter(a => a.v !== undefined && a.v !== null && a.v !== '');
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
    return { ...base, latest: vals.slice(-100).reverse().map(a => { const ref = people.get(a.x.r.distinct_id); return { value: String(a.v), timestamp: new Date(a.x.r.timestamp).toISOString(), distinct_id: a.x.r.distinct_id, person: ref?.uuid ? { id: ref.uuid, name: (ref.props.email ?? ref.props.name ?? a.x.r.distinct_id) as string } : null }; }) };
  });
  return { shown: { events: shown.length, persons: uniq(shown) }, dismissed: { events: dismissed.length, persons: uniq(dismissed) },
    sent: { responses: responses.length, completed: completed.length, persons: uniq(responses.map(x => x.r)) },
    response_rate: uniq(shown) ? uniq(responses.map(x => x.r)) / uniq(shown) : null, questions };
}
