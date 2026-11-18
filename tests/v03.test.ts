// 0.3: actions, cohorts, streamed funnels, SQL, experience continuity, survey targeting and partial responses, heatmaps,
// replay settings and paging, local evaluation (design.md 0.3 sections, protocol.md 14-18).
import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { normalize } from '../src/worker/capture';
import type { NormEvent } from '../src/worker/env';
import type { ProjectStore } from '../src/worker/store';
import { parseElementsChain, parseSelector, selectorMatches } from '../src/shared/elements';
import { cleanStep, jsConditionsMatch } from '../src/shared/actions';
import { setFunnelBatchRows } from '../src/worker/query';
import { parse as parseSql } from '../src/worker/sqlquery';

const E = env as any;
let n = 0;
const store = () => E.STORE.get(E.STORE.idFromName(`v03:${++n}:${Math.random()}`)) as unknown as ProjectStore;
const NOW = Date.parse('2026-03-10T12:00:00Z');
const QC = { timezone: 'UTC', now: NOW };
function norm(raw: any, ts: string): NormEvent {
  const r = normalize({ ...raw, timestamp: ts }, { now: NOW, sentAt: null, ip: null, geo: {} }, { v1: false, anonymizeIps: false });
  if ('drop' in r) throw new Error(r.drop);
  return r;
}
const at = (i: number) => new Date(Date.parse('2026-03-05T00:00:00Z') + i * 3600_000).toISOString();
const CHAIN_CTA = 'button.btn.primary:attr__class="btn primary"attr__id="cta"attr_id="cta"nth-child="2"nth-of-type="1"text="Sign up";form.signup:attr__class="signup"nth-child="1"nth-of-type="1";body:nth-child="2"nth-of-type="1"';
const CHAIN_LINK = 'a:attr__href="/pricing"href="/pricing"nth-child="1"nth-of-type="1"text="Pricing";nav.top:attr__class="top"nth-child="1"nth-of-type="1";body:nth-child="2"nth-of-type="1"';

describe('elements chain and selectors', () => {
  it('parses posthog-js elements_chain strings', () => {
    const els = parseElementsChain(CHAIN_CTA);
    expect(els.map(e => e.tag)).toEqual(['button', 'form', 'body']);
    expect(els[0]).toMatchObject({ classes: ['btn', 'primary'], id: 'cta', text: 'Sign up', nthChild: 2 });
    expect(parseElementsChain('a:text="say \\"hi\\";ok"href="/x"')[0]).toMatchObject({ text: 'say "hi";ok', href: '/x' });
  });
  it('matches compound, descendant and child selectors', () => {
    const els = parseElementsChain(CHAIN_CTA);
    for (const [sel, want] of [['#cta', true], ['button.primary', true], ['form button', true], ['form > button', true], ['body > button', false], ['body button', true],
      ['[id="cta"]', true], ['button:nth-child(2)', true], ['button:nth-child(1)', false], ['.signup', true], ['div button', false], ['button[class*="prim"]', true]] as [string, boolean][])
      expect([sel, selectorMatches(parseSelector(sel), els)]).toEqual([sel, want]);
    expect(() => parseSelector('a, b')).toThrow(/not supported/);
  });
  it('action step JS conditions: selector, href, regex', () => {
    const props = { $elements_chain: CHAIN_LINK, $current_url: 'https://shop.test/en/home', $el_text: 'Pricing' };
    expect(jsConditionsMatch(cleanStep({ event: '$autocapture', href: '/pricing' }), props)).toBe(true);
    expect(jsConditionsMatch(cleanStep({ event: '$autocapture', href: 'pric', href_matching: 'contains' }), props)).toBe(true);
    expect(jsConditionsMatch(cleanStep({ selector: 'nav a' }), props)).toBe(true);
    expect(jsConditionsMatch(cleanStep({ selector: 'form a' }), props)).toBe(false);
    expect(jsConditionsMatch(cleanStep({ url: '/(en|de)/home$', url_matching: 'regex' }), props)).toBe(true);
    expect(() => cleanStep({})).toThrow(/at least one condition/);
  });
});

/** Three people: A clicks the CTA twice and pays; B clicks the pricing link; C only views pages. */
async function seed(s: ProjectStore) {
  const evs: [number, any][] = [
    [0, { event: '$pageview', distinct_id: 'a', properties: { $current_url: 'https://shop.test/en/home' }, $set: { email: 'a@corp.test', plan: 'pro' } }],
    [1, { event: '$autocapture', distinct_id: 'a', properties: { $event_type: 'click', $el_text: 'Sign up', $elements_chain: CHAIN_CTA, $current_url: 'https://shop.test/en/home' } }],
    [2, { event: '$autocapture', distinct_id: 'a', properties: { $event_type: 'click', $el_text: 'Sign up', $elements_chain: CHAIN_CTA, $current_url: 'https://shop.test/de/home' } }],
    [3, { event: 'paid', distinct_id: 'a', properties: { amount: 30 } }],
    [30, { event: '$pageview', distinct_id: 'b', properties: { $current_url: 'https://shop.test/en/home' }, $set: { email: 'b@else.test', plan: 'free' } }],
    [31, { event: '$autocapture', distinct_id: 'b', properties: { $event_type: 'click', $el_text: 'Pricing', $elements_chain: CHAIN_LINK, $current_url: 'https://shop.test/en/home' } }],
    [32, { event: 'paid', distinct_id: 'b', properties: { amount: 10 } }],
    [60, { event: '$pageview', distinct_id: 'c', properties: { $current_url: 'https://shop.test/en/about' }, $set: { email: 'c@corp.test', plan: 'free' } }],
    [61, { event: '$pageview', distinct_id: 'c', properties: { $current_url: 'https://shop.test/en/home' } }],
  ];
  for (const [i, ev] of evs) await s.ingest([norm(ev, at(i))]);
}
const RANGE = { date_from: '2026-03-01', date_to: '2026-03-10' };
const total = (r: any) => r.results.map((x: any) => x.count);
/** Error text of a rejected store call (try/catch, as the other suites, so the RPC rejection is handled). */
async function errOf(p: Promise<unknown>) { try { await p; return ''; } catch (e) { return String(e); } }

describe('actions', () => {
  it('CRUD, and trends/funnels over action series (selector, url, text, href)', async () => {
    const s = store(); await seed(s);
    const cta = await s.saveAction(null, { name: 'Clicked CTA', steps: [{ event: '$autocapture', selector: 'form > #cta' }] }) as any;
    const cta2 = await s.saveAction(null, { name: 'CTA by text on en', steps: [{ event: '$autocapture', text: 'Sign up', url: '/en/', url_matching: 'contains' }] }) as any;
    const anyClick = await s.saveAction(null, { name: 'CTA or pricing', steps: [{ event: '$autocapture', selector: '#cta' }, { event: '$autocapture', href: '/pricing' }] }) as any;
    expect((await s.saveAction(null, { name: 'bad', steps: [{ selector: 'a,b' }] }) as any).error).toMatch(/not supported/);
    expect((await s.listActions()).length).toBe(3);
    const tr: any = await s.query({ kind: 'TrendsQuery', dateRange: RANGE, trendsFilter: { display: 'BoldNumber' },
      series: [{ kind: 'ActionsNode', id: cta.id }, { kind: 'ActionsNode', id: cta2.id }, { kind: 'ActionsNode', id: anyClick.id, math: 'dau' }] }, QC);
    expect(total(tr)).toEqual([2, 1, 2]);
    expect(tr.results[0].action).toMatchObject({ id: cta.id, type: 'actions', name: 'Clicked CTA' });
    const fu: any = await s.query({ kind: 'FunnelsQuery', dateRange: RANGE, series: [{ event: '$pageview' }, { kind: 'ActionsNode', id: anyClick.id }, { event: 'paid' }] }, QC);
    expect(fu.results.map((x: any) => x.count)).toEqual([3, 2, 2]);
    expect(fu.results[1].name).toBe('CTA or pricing');
    expect(await s.deleteAction(cta.id)).toBe(true);
    expect(await errOf(s.query({ kind: 'TrendsQuery', dateRange: RANGE, series: [{ kind: 'ActionsNode', id: cta.id }] }, QC))).toMatch(/unknown action/);
  });
});

describe('cohorts', () => {
  it('property, behavioral, static and nested cohorts; filters in insights and flags', async () => {
    const s = store(); await seed(s);
    const corp = await s.saveCohort(null, { name: 'Corp', filters: { properties: { type: 'OR', values: [{ type: 'AND', values: [{ type: 'person', key: 'email', value: 'corp.test', operator: 'icontains' }] }] } } }) as any;
    expect(corp.count).toBe(2);
    const payers = await s.saveCohort(null, { name: 'Paid twice+', filters: { properties: { type: 'AND', values: [{ type: 'behavioral', key: 'paid', value: 'performed_event', event_type: 'events', time_value: 30, time_interval: 'day' }] } } }) as any;
    // behavioral windows are relative to the real clock: recompute with a fixed "now"
    await s.calculateCohort(payers.id, NOW);
    expect((await s.getCohort(payers.id))!.count).toBe(2);
    const corpPayers = await s.saveCohort(null, { name: 'Corp payers', filters: { properties: { type: 'AND', values: [{ type: 'cohort', key: 'id', value: corp.id }, { type: 'cohort', key: 'id', value: payers.id }] } } }) as any;
    await s.calculateCohort(corpPayers.id, NOW);
    expect((await s.getCohort(corpPayers.id))!.count).toBe(1);
    const notPaid = await s.saveCohort(null, { name: 'Never paid', filters: { properties: { type: 'AND', values: [{ type: 'behavioral', key: 'paid', value: 'performed_event', time_value: 30, time_interval: 'day', negation: true }] } } }) as any;
    await s.calculateCohort(notPaid.id, NOW);
    expect((await s.cohortPersons(notPaid.id, null)).results.map((p: any) => p.properties.email)).toEqual(['c@corp.test']);
    const st = await s.saveCohort(null, { name: 'VIPs', is_static: true, csv: 'email\nb@else.test\nnobody@x.test\n' }) as any;
    expect(st.count).toBe(1);
    await s.addCohortPersons(st.id, { distinct_ids: ['c'] });
    expect((await s.getCohort(st.id))!.count).toBe(2);
    expect((await s.saveCohort(corp.id, { filters: { properties: { type: 'AND', values: [{ type: 'cohort', key: 'id', value: corpPayers.id }] } } }) as any).error).toMatch(/cycle/);
    // insights
    const tr = async (props: any[]) => total(await s.query({ kind: 'TrendsQuery', dateRange: RANGE, trendsFilter: { display: 'BoldNumber' }, series: [{ event: '$pageview', math: 'dau' }], properties: props }, QC));
    expect(await tr([{ type: 'cohort', key: 'id', value: corp.id }])).toEqual([2]);
    expect(await tr([{ type: 'cohort', key: 'id', value: st.id }])).toEqual([2]);
    expect(await tr([{ type: 'cohort', key: 'id', value: st.id, operator: 'not_in' }])).toEqual([1]);
    expect(await tr([{ type: 'cohort', key: 'id', value: corpPayers.id }])).toEqual([1]);
    // flags: cohort condition
    const f = await s.saveFlag(null, { key: 'corp-only', filters: { groups: [{ properties: [{ type: 'cohort', key: 'id', value: corp.id }], rollout_percentage: 100 }] } }) as any;
    expect(f.id).toBeTruthy();
    const ev = async (did: string) => (await s.evaluateFlags(did, {})).find(x => x.key === 'corp-only')!.enabled;
    expect([await ev('a'), await ev('b'), await ev('c'), await ev('unknown')]).toEqual([true, false, true, false]);
    // local evaluation definitions: the property-only cohort is sent, a static one is not
    await s.saveFlag(null, { key: 'vip', filters: { groups: [{ properties: [{ type: 'cohort', key: 'id', value: st.id }], rollout_percentage: 100 }] } });
    const defs: any = await s.flagDefinitions(true);
    expect(Object.keys(defs.cohorts)).toEqual([String(corp.id)]);
    expect(defs.cohorts[corp.id]).toMatchObject({ type: 'OR', values: [{ type: 'AND', values: [{ key: 'email', type: 'person', operator: 'icontains' }] }] });
    expect(defs.flags.map((x: any) => x.key).sort()).toEqual(['corp-only', 'vip']);
    expect(await s.deleteCohort(st.id)).toBe(true);
  });
});

describe('streamed funnels', () => {
  it('same result in one batch and in many small batches', async () => {
    const s = store();
    let k = 0;
    for (let p = 0; p < 40; p++) {
      const did = `u${p}`;
      await s.ingest([norm({ event: '$pageview', distinct_id: did }, at(k++)), ...(p % 2 ? [norm({ event: 'signup', distinct_id: did }, at(k++))] : []), ...(p % 4 === 1 ? [norm({ event: 'paid', distinct_id: did }, at(k++))] : [])]);
    }
    // an anonymous id merged into u3 later still counts as one person
    await s.ingest([norm({ event: '$pageview', distinct_id: 'anon3' }, at(k++)), norm({ event: '$identify', distinct_id: 'u3', properties: { $anon_distinct_id: 'anon3' } }, at(k++))]);
    const q = { kind: 'FunnelsQuery', dateRange: { date_from: '2026-03-01', date_to: '2026-03-10' }, series: [{ event: '$pageview' }, { event: 'signup' }, { event: 'paid' }] };
    const one: any = await s.query(q, QC);
    setFunnelBatchRows(3);
    try { const many: any = await s.query(q, QC); expect(many.results.map((r: any) => r.count)).toEqual(one.results.map((r: any) => r.count)); }
    finally { setFunnelBatchRows(100_000); }
    expect(one.results.map((r: any) => r.count)).toEqual([40, 20, 10]);
  });
});

describe('SQL', () => {
  it('parses a safe subset and rejects everything else', () => {
    expect(parseSql('select event, count() from events group by event order by 2 desc limit 5').limit).toBe(5);
    for (const bad of ['DELETE FROM events', 'select * from users', 'select 1 from events; drop table events', 'select sleep(1) from events', 'select (select 1) from events', 'select * from events e join persons p on 1'])
      expect(() => parseSql(bad)).toThrow();
  });
  it('aggregates across shards, person columns, persons table, limits', async () => {
    const s = store(); await seed(s);
    const q = (sql: string) => s.sqlQuery(sql, QC) as Promise<any>;
    expect((await q(`SELECT event, count() AS c FROM events GROUP BY event ORDER BY c DESC, event`)).results).toEqual([['$pageview', 4], ['$autocapture', 3], ['paid', 2]]);
    expect((await q(`SELECT sum(properties.amount), avg(properties.amount), uniq(distinct_id), count(DISTINCT person_id) FROM events WHERE event = 'paid'`)).results).toEqual([[40, 20, 2, 2]]);
    expect((await q(`SELECT person.properties.plan AS plan, count() FROM events GROUP BY plan ORDER BY plan`)).results).toEqual([['free', 5], ['pro', 4]]);
    expect((await q(`SELECT count() FROM events WHERE person.properties.email LIKE '%corp.test' AND event = '$pageview'`)).results).toEqual([[3]]);
    const days = await q(`SELECT toStartOfDay(timestamp) AS d, count() FROM events WHERE timestamp >= '2026-03-05' AND timestamp < now() GROUP BY d ORDER BY d`);
    expect(days.types[0]).toBe('DateTime');
    expect(days.results.map((r: any) => r[0])).toEqual(['2026-03-05T00:00:00.000Z', '2026-03-06T00:00:00.000Z', '2026-03-07T00:00:00.000Z']);
    const rows = await q(`SELECT event, properties.$current_url, person.properties.email FROM events WHERE event = '$pageview' ORDER BY timestamp DESC LIMIT 2`);
    expect(rows.columns).toEqual(['event', 'properties.$current_url', 'person.properties.email']);
    expect(rows.results).toEqual([['$pageview', 'https://shop.test/en/home', 'c@corp.test'], ['$pageview', 'https://shop.test/en/about', 'c@corp.test']]);
    expect(rows.hasMore).toBe(true);
    expect((await q(`SELECT properties.plan, count() FROM persons GROUP BY 1 HAVING count() > 1`)).results).toEqual([['free', 2]]);
    expect((await q(`SELECT count() FROM events WHERE event = 'nothing'`)).results).toEqual([[0]]);
    expect(await errOf(q(`SELECT event, count() FROM events`))).toMatch(/GROUP BY/);
    expect(await errOf(q(`SELECT count() FROM events WHERE event = person.properties.plan`))).toMatch(/mix/);
    // the HogQLQuery kind of /query runs the same engine
    expect((await s.query({ kind: 'HogQLQuery', query: 'select count() from events' }, QC) as any).results).toEqual([[9]]);
  });
});

describe('experience continuity', () => {
  it('keeps the anonymous variant after identify ($anon_distinct_id)', async () => {
    const s = store();
    await s.saveFlag(null, { key: 'exp', ensure_experience_continuity: true, filters: { groups: [{ properties: [], rollout_percentage: 100 }], multivariate: { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] } } });
    await s.saveFlag(null, { key: 'plain', filters: { groups: [{ properties: [], rollout_percentage: 100 }], multivariate: { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] } } });
    // find an anonymous id whose variant differs from the identified id's own hash
    let anon = '', user = '';
    for (let i = 0; i < 200 && !anon; i++) {
      const a = `anon-${i}`, u = `user-${i}`;
      const va = (await s.evaluateFlags(a, {})).find(f => f.key === 'exp')!.variant, vu = (await s.evaluateFlags(u, {})).find(f => f.key === 'exp')!.variant;
      if (va !== vu) { anon = a; user = u; }
    }
    expect(anon).not.toBe('');
    const before = (await s.evaluateFlags(anon, {})).find(f => f.key === 'exp')!.variant;
    const after = (await s.evaluateFlags(user, {}, null, anon)).find(f => f.key === 'exp')!.variant;
    expect(after).toBe(before);
    // later requests without $anon_distinct_id, and after the merge, keep it
    await s.ingest([norm({ event: '$identify', distinct_id: user, properties: { $anon_distinct_id: anon } }, at(1))]);
    expect((await s.evaluateFlags(user, {})).find(f => f.key === 'exp')!.variant).toBe(before);
    expect((await s.evaluateFlags(anon, {})).find(f => f.key === 'exp')!.variant).toBe(before);
    // flags without continuity hash the current id
    expect((await s.evaluateFlags(user, {}, null, anon)).find(f => f.key === 'plain')!.variant).toBe((await s.evaluateFlags(user, {})).find(f => f.key === 'plain')!.variant);
    // new experiments turn continuity on
    const e: any = await s.saveExperiment(null, { name: 'E', feature_flag_key: 'new-exp' });
    expect((await s.getFlag(e.feature_flag_id))!.ensure_experience_continuity).toBe(true);
  });
});

describe('surveys 0.3', () => {
  it('targeting and internal flags, iterations, conditions', async () => {
    const s = store(); await seed(s);
    const corp = await s.saveCohort(null, { name: 'Corp', filters: { properties: { type: 'AND', values: [{ type: 'person', key: 'email', value: 'corp.test', operator: 'icontains' }] } } }) as any;
    const act = await s.saveAction(null, { name: 'CTA', steps: [{ event: '$autocapture', selector: '#cta' }] }) as any;
    const sv: any = await s.saveSurvey(null, { name: 'NPS', type: 'popover', questions: [{ type: 'rating', question: 'How likely?', scale: 10 }], action: 'launch',
      targeting_flag_filters: { groups: [{ properties: [{ type: 'cohort', key: 'id', value: corp.id }], rollout_percentage: 100 }] },
      conditions: { url: 'shop.test', urlMatchType: 'icontains', selector: '#cta', deviceTypes: ['Desktop'], seenSurveyWaitPeriodInDays: 14, actions: { values: [{ id: act.id }] } },
      iteration_count: 3, iteration_frequency_days: 30 });
    expect(sv.targeting_flag_key).toMatch(/^survey-targeting-/);
    expect(sv.internal_targeting_flag_key).toBe(sv.targeting_flag_key + '-custom');
    expect(sv.current_iteration).toBe(1);
    expect(sv.schedule).toBe('recurring');
    const pub = (await s.activeSurveys())[0] as any;
    expect(pub.conditions.actions.values[0]).toMatchObject({ id: act.id, name: 'CTA', steps: [{ selector: '#cta' }] });
    expect(pub.feature_flag_keys.map((k: any) => k.key)).toEqual(['flag', 'targeting_flag', 'internal_targeting_flag']);
    const on = async (did: string, key: string) => (await s.evaluateFlags(did, {})).find(f => f.key === key)?.enabled;
    expect([await on('a', sv.targeting_flag_key), await on('b', sv.targeting_flag_key)]).toEqual([true, false]);
    expect(await on('a', sv.internal_targeting_flag_key)).toBe(true);
    // a response sets $survey_responded/<id>/<iteration> and turns the internal flag off for that person
    await s.ingest([norm({ event: 'survey sent', distinct_id: 'a', properties: { $survey_id: sv.id, $survey_response: 9, $survey_iteration: 1, $set: { [`$survey_responded/${sv.id}/1`]: true } } }, at(70))]);
    expect(await on('a', sv.internal_targeting_flag_key)).toBe(false);
    // internal flags are hidden from the flags list
    expect((await s.listFlags()).some((f: any) => f.key.startsWith('survey-targeting-'))).toBe(false);
    expect((await s.saveSurvey(null, { name: 'x', questions: [{ type: 'open', question: 'q' }], conditions: { actions: { values: [{ id: 9999 }] } } }) as any).error).toMatch(/unknown action/);
    await s.deleteSurvey(sv.id);
    expect((await s.listFlags(true)).some((f: any) => f.key.startsWith('survey-targeting-'))).toBe(false);
  });
  it('merges partial responses per submission and counts abandoned', async () => {
    const s = store();
    const sv: any = await s.saveSurvey(null, { name: 'Two', enable_partial_responses: true, action: 'launch', questions: [{ id: 'q1', type: 'open', question: 'One?' }, { id: 'q2', type: 'single_choice', question: 'Two?', choices: ['x', 'y'] }] });
    const base = { $survey_id: sv.id };
    await s.ingest([
      norm({ event: 'survey shown', distinct_id: 'p1', properties: base }, at(0)),
      norm({ event: 'survey sent', distinct_id: 'p1', properties: { ...base, $survey_submission_id: 'sub1', $survey_completed: false, $survey_response_q1: 'hello' } }, at(1)),
      norm({ event: 'survey sent', distinct_id: 'p1', properties: { ...base, $survey_submission_id: 'sub1', $survey_completed: true, $survey_response_q1: 'hello!', $survey_response_q2: 'y' } }, at(2)),
      norm({ event: 'survey shown', distinct_id: 'p2', properties: base }, at(3)),
      norm({ event: 'survey sent', distinct_id: 'p2', properties: { ...base, $survey_submission_id: 'sub2', $survey_completed: false, $survey_response_q1: 'partial only' } }, at(4)),
      norm({ event: 'survey abandoned', distinct_id: 'p2', properties: { ...base, $survey_partially_completed: true } }, at(5)),
    ]);
    const r: any = await s.surveyResults(sv.id);
    expect(r.sent).toEqual({ responses: 2, completed: 1, partial: 1, persons: 2 });
    expect(r.abandoned.events).toBe(1);
    expect(r.questions[0].latest.map((x: any) => x.value)).toEqual(['partial only', 'hello!']);
    expect(r.questions[1].choices).toEqual([{ choice: 'x', count: 0 }, { choice: 'y', count: 1 }]);
  });
});

describe('heatmaps and scroll depth', () => {
  it('aggregates $$heatmap points relative to the viewport', async () => {
    const s = store();
    const url = 'https://shop.test/en/home';
    const hm = (did: string, pts: any[], vw = 1000) => norm({ event: '$$heatmap', distinct_id: did, properties: { $viewport_width: vw, $viewport_height: 800, $current_url: url, $heatmap_data: { [url]: pts } } }, at(1));
    await s.ingest([hm('a', [{ x: 500, y: 100, target_fixed: false, type: 'click' }, { x: 503, y: 110, target_fixed: false, type: 'click' }, { x: 10, y: 10, target_fixed: true, type: 'mousemove' }]),
      hm('b', [{ x: 1000, y: 100, target_fixed: false, type: 'click' }], 2000), hm('c', [{ x: 50, y: 900, target_fixed: false, type: 'rageclick' }])]);
    const r: any = await s.heatmap({ type: 'click', date_from: '2026-03-01', date_to: '2026-03-10', url_exact: url });
    expect(r.results).toEqual([{ pointer_relative_x: 0.5, pointer_target_fixed: false, client_y: 96, count: 3 }]);
    expect((await s.heatmap({ type: 'click', date_from: '2026-03-01', date_to: '2026-03-10', url_pattern: 'https://shop.test/*', aggregation: 'unique_visitors' }) as any).results[0].count).toBe(2);
    expect((await s.heatmap({ type: 'click', date_from: '2026-03-01', date_to: '2026-03-10', viewport_width_min: 1500 }) as any).results[0].count).toBe(1);
    expect((await s.heatmapUrls({ date_from: '2026-03-01', date_to: '2026-03-10' }) as any).results).toEqual([{ url, count: 5 }]);
    // $$heatmap events are hidden from the events list by default
    expect((await s.query({ kind: 'EventsQuery', limit: 10 }, QC) as any).results.length).toBe(0);
  });
  it('scroll depth from $prev_pageview_max_scroll_percentage', async () => {
    const s = store();
    const pl = (pct: number, i: number) => norm({ event: '$pageleave', distinct_id: 'd' + i, properties: { $prev_pageview_pathname: '/en/home', $prev_pageview_max_scroll_percentage: pct } }, at(i));
    await s.ingest([pl(1, 1), pl(0.5, 2), pl(0.26, 3), pl(0.1, 4)]);
    const r: any = await s.scrollDepth({ date_from: '2026-03-01', date_to: '2026-03-10', url_exact: 'https://shop.test/en/home?x=1' });
    expect(r.pageviews).toBe(4);
    const at_ = (p: number) => r.results.find((x: any) => x.percentage === p).count;
    expect([at_(0), at_(25), at_(50), at_(100)]).toEqual([4, 3, 2, 1]);
  });
});

const SITE = 'http://app.test';
const W = (exports as any).default;
const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set('cookie', init.cookie);
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && !h.has('origin') && path.startsWith('/api/')) h.set('origin', SITE);
  return W.fetch(new Request(SITE + path, { ...init, headers: h })) as Promise<Response>;
};
async function owner() {
  const body = JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' });
  let r = await call('/api/signup', { method: 'POST', body });
  if (r.status !== 201) r = await call('/api/login', { method: 'POST', body });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const p = await (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'T', timezone: 'UTC' }), cookie })).json() as any;
  return { cookie, p };
}

describe('HTTP 0.3', () => {
  it('local evaluation: personal key, ETag, 304, older path', async () => {
    const { cookie, p } = await owner();
    await call(`/api/projects/${p.id}/feature_flags`, { method: 'POST', cookie, body: JSON.stringify({ key: 'f1', filters: { groups: [{ properties: [{ key: 'plan', value: 'pro', type: 'person' }], rollout_percentage: 100 }] } }) });
    const { key } = await (await call('/api/personal_api_keys', { method: 'POST', cookie, body: JSON.stringify({ label: 'server' }) })).json() as any;
    expect((await call(`/flags/definitions?token=${p.api_token}&send_cohorts`)).status).toBe(401);
    const r = await call(`/flags/definitions?token=${p.api_token}&send_cohorts`, { headers: { authorization: `Bearer ${key}` } });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.flags[0]).toMatchObject({ key: 'f1', active: true, deleted: false, ensure_experience_continuity: false });
    expect(body.cohorts).toEqual({});
    const etag = r.headers.get('etag')!;
    expect((await call(`/flags/definitions?token=${p.api_token}&send_cohorts`, { headers: { authorization: `Bearer ${key}`, 'if-none-match': etag } })).status).toBe(304);
    expect((await call(`/api/feature_flag/local_evaluation?token=${p.api_token}`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await call(`/api/projects/${p.id}/feature_flags/local_evaluation`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
  });
  it('replay settings reach remote config; heatmaps switch; SQL endpoint', async () => {
    const { cookie, p } = await owner();
    const bad = await call(`/api/projects/${p.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ replay_config: { sample_rate: 2 } }) });
    expect(bad.status).toBe(400);
    const r = await call(`/api/projects/${p.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ session_recording: true, heatmaps: true, replay_config: {
      sample_rate: 0.5, minimum_duration_ms: 2000, linked_flag: { key: 'rec', variant: 'on' }, console: true, network: { timing: true, headers: true, body: false },
      canvas: { enabled: true, fps: 4, quality: 0.4 }, url_triggers: ['/checkout'], event_triggers: ['paid'], trigger_match: 'all', masking: { mask_all_inputs: true, block_selector: '.secret' } } }) });
    expect(r.status).toBe(200);
    const cfg: any = await (await call(`/array/${p.api_token}/config`)).json();
    expect(cfg.heatmaps).toBe(true);
    expect(cfg.captureDeadClicks).toBe(true);
    expect(cfg.capturePerformance).toEqual({ network_timing: true, web_vitals: false });
    expect(cfg.sessionRecording).toMatchObject({ endpoint: '/s/', sampleRate: '0.50', minimumDurationMilliseconds: 2000, linkedFlag: { flag: 'rec', variant: 'on' },
      networkPayloadCapture: { recordHeaders: true, recordBody: false }, urlTriggers: [{ url: '/checkout', matching: 'regex' }], eventTriggers: ['paid'], triggerMatchType: 'all',
      recordCanvas: true, canvasFps: 4, canvasQuality: '0.4', masking: { maskAllInputs: true, blockSelector: '.secret' } });
    const q = await call(`/api/projects/${p.id}/sql`, { method: 'POST', cookie, body: JSON.stringify({ query: 'select count() from events' }) });
    expect(((await q.json()) as any).results).toEqual([[0]]);
    const e = await call(`/api/projects/${p.id}/sql`, { method: 'POST', cookie, body: JSON.stringify({ query: 'drop table events' }) });
    expect(e.status).toBe(400);
  });
  it('snapshots are paged with a cursor', async () => {
    const { cookie, p } = await owner();
    await call(`/api/projects/${p.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ session_recording: true }) });
    const big = 'x'.repeat(200_000);
    for (let i = 0; i < 3; i++) {
      const items = [{ type: i === 0 ? 2 : 3, timestamp: 1_772_700_000_000 + i * 1000, data: i === 0 ? { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } } : { source: 0, texts: [], attributes: [], removes: [], adds: [], pad: big } }];
      const res = await call('/s/', { method: 'POST', body: JSON.stringify({ api_key: p.api_token, batch: [{ event: '$snapshot', distinct_id: 'd', properties: { $session_id: 'sess-1', $snapshot_data: items } }] }) });
      expect(res.status).toBe(200);
    }
    // the queue consumer records the metadata; wait for it
    for (let i = 0; i < 50 && (await call(`/api/projects/${p.id}/session_recordings/sess-1`, { cookie })).status !== 200; i++) await new Promise(r => setTimeout(r, 100));
    const { readSnapshotsPage } = await import('../src/worker/replay');
    const first = await readSnapshotsPage(E, p.id, 'sess-1', null, 100);
    expect(first.snapshots.length).toBe(1); expect(first.next).toBeTruthy();
    const second = await readSnapshotsPage(E, p.id, 'sess-1', first.next, 100);
    const third = await readSnapshotsPage(E, p.id, 'sess-1', second.next, 100);
    expect([second.snapshots.length, third.snapshots.length, third.next]).toEqual([1, 1, null]);
    const viaApi: any = await (await call(`/api/projects/${p.id}/session_recordings/sess-1/snapshots?paged=1`, { cookie })).json();
    expect(viaApi.snapshots.length).toBe(3); expect(viaApi.next).toBeNull();
  });
});
