// End to end against a running instance (npm run dev): the real posthog-js snippet in Chromium and posthog-node send
// events; the owner API and UI then show the right persons, flags and insight numbers. Usage:
//   SITE=http://localhost:8787 E2E_EMAIL=… E2E_PASSWORD=… npm run e2e
import http from 'node:http';
import { chromium } from 'playwright';
import { PostHog } from 'posthog-node';
import FX from '../tests/fixtures/v05-errors.json';

const SITE = (process.env.SITE ?? 'http://localhost:8787').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'correct horse battery';
let cookie = '';
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); if (!ok) failures++; };
async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const r = await fetch(SITE + path, { method, headers: { origin: SITE, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms; let v = await f();
  while (!ok(v) && Date.now() < end) { await sleep(300); v = await f(); }
  return v;
}

// 1. account and a fresh project (0.2: session recording on, an experiment on checkout-test, a launched NPS survey)
try { await api('/api/signup', 'POST', { email: EMAIL, password: PASSWORD, name: 'E2E' }); } catch (e: any) { if (e.status !== 403 && e.status !== 409) throw e; }
await api('/api/login', 'POST', { email: EMAIL, password: PASSWORD });
const project = await api('/api/projects', 'POST', { name: `e2e ${new Date().toISOString()}`, timezone: 'UTC' });
const A = `/api/projects/${project.id}`;
await api(`${A}/feature_flags`, 'POST', { key: 'new-dashboard', filters: { groups: [{ properties: [{ key: 'email', value: ['ada@example.com'], operator: 'exact', type: 'person' }], rollout_percentage: 100 }] } });
await api(`${A}/feature_flags`, 'POST', { key: 'checkout-test', filters: { groups: [{ properties: [], rollout_percentage: 100 }], multivariate: { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] }, payloads: { test: '{"color":"green"}', control: '{"color":"blue"}' } } });
// New projects sample autocapture at 50% (0.5 default); the action and cohort checks below need every click.
await api(A, 'PATCH', { session_recording: true, heatmaps: true, replay_config: { console: true, network: { timing: true } }, limits: { autocapture_sample_rate: 1 } });
// 0.3: the experiment flag keeps its variant across identify ($anon_distinct_id -> hash key override)
const flags0 = await api(`${A}/feature_flags`);
await api(`${A}/feature_flags/${flags0.find((f: any) => f.key === 'checkout-test').id}`, 'PATCH', { ensure_experience_continuity: true });
const experiment = await api(`${A}/experiments`, 'POST', { name: 'Checkout test', feature_flag_key: 'checkout-test', metrics: [{ kind: 'funnel', series: [{ event: 'clicked_cta' }] }] });
await api(`${A}/experiments/${experiment.id}`, 'PATCH', { action: 'launch' });
const survey = await api(`${A}/surveys`, 'POST', { name: 'NPS', type: 'popover', enable_partial_responses: true, conditions: { events: { values: [{ name: 'opened_pricing' }] } }, questions: [
  { type: 'rating', id: 'q-rating', question: 'How likely are you to recommend us?', display: 'number', scale: 10, lowerBoundLabel: 'Unlikely', upperBoundLabel: 'Very likely' },
  { type: 'single_choice', id: 'q-choice', question: 'What brought you here?', choices: ['Search', 'Friend', 'Ad'] },
  { type: 'open', id: 'q-open', question: 'Anything else?' }] });
await api(`${A}/surveys/${survey.id}`, 'PATCH', { action: 'launch' });

// 2. a customer site on another origin with the install snippet from the Settings page
const snippet = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;
const page = (title: string) => `<!doctype html><html><head><title>${title}</title><script>${snippet}
posthog.init(${JSON.stringify(project.api_token)}, { api_host: ${JSON.stringify(SITE)}, person_profiles: 'identified_only', opt_out_useragent_filter: true })
setTimeout(() => console.warn('e2e-console-marker'), 1500)</script></head>
<body><h1>${title}</h1>
<button id="cta" onclick="posthog.capture('clicked_cta',{plan:'pro',price:12})">Buy</button>
<button id="identify" onclick="posthog.identify('user-42',{email:'ada@example.com'},{first_plan:'free'})">Identify</button>
<button id="group" onclick="posthog.group('company','acme',{name:'Acme Inc'})">Group</button>
<button id="flags" onclick="posthog.reloadFeatureFlags();posthog.onFeatureFlags(()=>{document.getElementById('out').textContent=JSON.stringify([posthog.isFeatureEnabled('new-dashboard'),posthog.getFeatureFlag('checkout-test'),posthog.getFeatureFlagPayload('checkout-test')])})">Flags</button>
<button id="pricing" onclick="posthog.capture('opened_pricing')">Pricing</button>
<button id="boom" onclick="setTimeout(function priceLabel(){ return null.toFixed(2) })">Boom</button> <input id="name" placeholder="name"> <input id="secret" type="password">
<a id="next" href="/page2">Next</a><pre id="out"></pre><p style="height:900px">Long page</p></body></html>`;
const site = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(page(q.url === '/page2' ? 'Page 2' : 'Home')); });
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
// posthog-js turns its network recorder off on localhost and 127.0.0.1, so the customer site gets its own host name.
const siteUrl = `http://e2e-site.test:${(site.address() as any).port}`;

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP e2e-site.test 127.0.0.1'] });
const ctx = await browser.newContext();
const p = await ctx.newPage();
const capturePosts: string[] = [];
p.on('request', r => { const u = new URL(r.url()); if (u.origin === SITE && r.method() === 'POST') capturePosts.push(u.pathname); });
await p.goto(siteUrl + '/');
await p.waitForFunction(() => (window as any).posthog?.__loaded);
await p.click('#flags'); // reads checkout-test before the CTA click: the experiment exposure
await until('exposure', () => p.textContent('#out'), v => !!v && v.length > 2, 10000);
await sleep(1500);
await p.fill('#name', 'Ada'); await p.fill('#secret', 'hunter2');
await p.click('#cta');
await p.click('#identify');
await p.click('#group');
await p.click('#flags');
// onFeatureFlags fires at once with the flags loaded before identify, then again after the reload that carries the new
// person properties; over a real network the first answer can arrive first, so wait for the post-identify one.
const out = await until('flags', () => p.textContent('#out'), v => !!v && v.startsWith('[true,'), 15000);
const [enabled, variant, payload] = JSON.parse(out ?? '[]');
check('posthog-js reads a person-property flag after identify', enabled === true, out);
check('posthog-js gets a variant and its payload', ['control', 'test'].includes(variant) && JSON.stringify(payload) === JSON.stringify(variant === 'test' ? { color: 'green' } : { color: 'blue' }), out);
// The survey: posthog-js loads /api/surveys and surveys.js, shows the popover after opened_pricing, sends 'survey sent'.
await p.click('#pricing');
const shown = await p.waitForSelector('.question-0-rating-9', { timeout: 15000 }).then(() => true).catch(() => false);
check('posthog-js shows the launched survey after its trigger event', shown, null);
if (shown) {
  await p.click('.question-0-rating-9'); await p.click('.form-submit');
  await p.click('#surveyQuestion1Choice1'); await p.click('.form-submit');
  await p.fill('textarea', 'Great product'); await p.click('.form-submit');
}
await p.click('#boom'); // 0.5: unhandled error, captured by exception autocapture switched on in remote config
await p.mouse.wheel(0, 600); await sleep(300); await p.mouse.wheel(0, -600);
await sleep(6000); // recorder and heatmap flush
await p.click('#next');
await p.waitForURL(/page2/);
await p.waitForFunction(() => (window as any).posthog?.__loaded);
await sleep(1500);
await p.evaluate(() => (window as any).posthog?._requestQueue?.flush?.());
await sleep(1500);
check('posthog-js posts to /e/ or /i/v0/e/ and /flags/', capturePosts.some(x => /^\/(e|i\/v0\/e)\/?$/.test(x)) && capturePosts.some(x => x.startsWith('/flags')), capturePosts);
check('the recorder posts snapshots to /s/', capturePosts.some(x => /^\/s\/?$/.test(x)), capturePosts);

// 3. posthog-node over /i/v1/analytics/events
const node = new PostHog(project.api_token, { host: SITE, flushAt: 1, flushInterval: 0 });
node.capture({ distinctId: 'server-1', event: 'order_completed', properties: { amount: 49.5, $set: { plan: 'team' } } });
node.identify({ distinctId: 'server-1', properties: { email: 'server@example.com' } });
node.alias({ distinctId: 'server-1', alias: 'legacy-9' });
const nodeFlag = (await node.evaluateFlags('server-1')).getFlag('checkout-test');
node.captureException(new RangeError('e2e node failure'), 'server-1', { route: '/checkout' });
await node.shutdown();
check('posthog-node evaluates a flag', ['control', 'test'].includes(String(nodeFlag)), nodeFlag);

// 4. what the instance stored
const events = await until('events', () => api(`${A}/events?limit=200`), (v: any) => v.results.some((e: any) => e.event === 'order_completed') && v.results.filter((e: any) => e.event === '$pageview').length >= 2);
const names = events.results.map((e: any) => e.event);
for (const n of ['$pageview', 'clicked_cta', '$identify', '$groupidentify', '$autocapture', '$pageleave', 'order_completed', '$create_alias']) check(`event ${n} stored`, names.includes(n), names);
const ada = (await api(`${A}/persons?search=ada@example.com`)).results[0];
check('identify merged the anonymous visitor into one person', !!ada && ada.distinct_ids.includes('user-42') && ada.distinct_ids.length === 2 && ada.properties.first_plan === 'free', ada);
const pv = events.results.filter((e: any) => e.event === '$pageview');
check('anonymous and identified pageviews resolve to the same person', pv.every((e: any) => e.person?.id === ada?.id), pv.map((e: any) => e.person));
const srv = (await api(`${A}/persons?search=server@example.com`)).results[0];
check('posthog-node alias joined legacy-9 to server-1', !!srv && [...srv.distinct_ids].sort().join() === 'legacy-9,server-1' && srv.properties.plan === 'team', srv);
const cta = events.results.find((e: any) => e.event === 'clicked_cta');
check('custom event properties and $lib survive', cta?.properties.plan === 'pro' && cta?.properties.price === 12 && cta?.properties.$lib === 'web', cta?.properties);
check('group was attached to later events', events.results.some((e: any) => e.properties.$groups?.company === 'acme'), null);

// 5. insights over this data
const q = (query: unknown) => api(`${A}/query`, 'POST', { query });
const tr = await q({ kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview', math: 'total' }, { kind: 'EventsNode', event: '$pageview', math: 'dau' }], dateRange: { date_from: '-1d' }, trendsFilter: { display: 'BoldNumber' } });
check('trends: 2 pageviews by 1 person', tr.results[0].aggregated_value === 2 && tr.results[1].aggregated_value === 1, tr.results.map((r: any) => r.aggregated_value));
const fu = await q({ kind: 'FunnelsQuery', series: [{ kind: 'EventsNode', event: '$pageview' }, { kind: 'EventsNode', event: 'clicked_cta' }, { kind: 'EventsNode', event: 'order_completed' }], dateRange: { date_from: '-1d' } });
check('funnel: 1 person viewed and clicked, none ordered', JSON.stringify(fu.results.map((s: any) => s.count)) === '[1,1,0]', fu.results.map((s: any) => s.count));
const re = await q({ kind: 'RetentionQuery', retentionFilter: { targetEntity: { id: '$pageview', type: 'events' }, returningEntity: { id: '$pageview', type: 'events' }, period: 'Day', totalIntervals: 2 } });
check('retention: today cohort of 1', re.results.at(-1).values[0].count === 1, re.results);

// 5b. 0.2: replay, survey results, experiment exposure
const recs = await until('recordings', () => api(`${A}/session_recordings`), (v: any) => v.results.length > 0 && v.results[0].click_count > 0);
const rec = recs.results[0];
check('a session recording was stored for the identified person', !!rec && rec.person?.name === 'ada@example.com' && rec.recording_duration > 0, rec);
const snaps = rec ? (await api(`${A}/session_recordings/${encodeURIComponent(rec.id)}/snapshots`)).snapshots : [];
check('snapshots come back decompressed with a full snapshot', snaps.some((e: any) => e.type === 2 && typeof e.data === 'object') && !snaps.some((e: any) => 'cv' in e), snaps.length);
check('password input was masked by the recorder', !JSON.stringify(snaps).includes('hunter2'), null);
const sres = await until('survey', () => api(`${A}/surveys/${survey.id}/results`), (v: any) => v.sent.completed > 0);
check('survey results: shown, NPS answer, choice and text', sres.shown.persons === 1 && sres.questions[0].nps === 100 && sres.questions[1].choices.find((c: any) => c.choice === 'Friend')?.count === 1 && sres.questions[2].latest[0]?.value === 'Great product', sres);
const xres = await api(`${A}/experiments/${experiment.id}/results`);
const exposures = xres.variants.reduce((a: number, v: any) => a + v.exposures, 0);
const conv = xres.metrics[0].variants.reduce((a: number, v: any) => a + v.conversions, 0);
// Exposures: Ada in the browser (posthog-js) and server-1 (posthog-node's evaluateFlags also sends $feature_flag_called).
// Flags hash the distinct_id, so Ada's variant can change at identify (PostHog's ensure_experience_continuity is not
// implemented); a person seen with two variants is excluded, as PostHog does. Only Ada clicked the CTA after exposure.
check('experiment: exposures from $feature_flag_called (browser and server), conversion only after exposure; continuity keeps one variant',
  exposures === 2 && xres.multiple_variant_persons === 0 && conv === 1, { variants: xres.variants, multiple: xres.multiple_variant_persons, conv });
check('survey partial responses: one submission, completed', sres.sent.responses === 1 && sres.sent.completed === 1, sres.sent);

// 5c. 0.3: actions, cohorts, SQL, heatmaps, scroll depth, replay console, local evaluation
const buy = await api(`${A}/actions`, 'POST', { name: 'Clicked Buy', steps: [{ event: '$autocapture', selector: 'button#cta', text: 'Buy' }] });
const p2 = await api(`${A}/actions`, 'POST', { name: 'Viewed page 2', steps: [{ event: '$pageview', url: '/page2', url_matching: 'contains' }] });
const at = await q({ kind: 'TrendsQuery', series: [{ kind: 'ActionsNode', id: buy.id, math: 'total' }, { kind: 'ActionsNode', id: p2.id, math: 'dau' }], dateRange: { date_from: '-1d' }, trendsFilter: { display: 'BoldNumber' } });
check('actions: CSS selector + text matches the Buy click; URL action matches page 2', at.results[0].aggregated_value === 1 && at.results[1].aggregated_value === 1, at.results.map((r: any) => r.aggregated_value));
const afu = await q({ kind: 'FunnelsQuery', series: [{ kind: 'ActionsNode', id: buy.id }, { kind: 'ActionsNode', id: p2.id }], dateRange: { date_from: '-1d' } });
check('actions as funnel steps', JSON.stringify(afu.results.map((s: any) => s.count)) === '[1,1]', afu.results.map((s: any) => s.count));
const buyers = await api(`${A}/cohorts`, 'POST', { name: 'Buyers', filters: { properties: { type: 'OR', values: [{ type: 'AND', values: [{ type: 'behavioral', key: buy.id, event_type: 'actions', value: 'performed_event', time_value: 30, time_interval: 'day' }] }] } } });
const listed = await api(`${A}/cohorts`, 'POST', { is_static: true, name: 'Server list', csv: 'distinct_id\nserver-1\n' });
check('dynamic behavioural cohort (performed action) and static CSV cohort', buyers.count === 1 && listed.count === 1, [buyers.count, listed.count]);
const ci = await q({ kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview', math: 'total' }], properties: [{ type: 'cohort', key: 'id', value: buyers.id, operator: 'in' }], dateRange: { date_from: '-1d' }, trendsFilter: { display: 'BoldNumber' } });
const cn = await q({ kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: 'order_completed', math: 'total' }], properties: [{ type: 'cohort', key: 'id', value: listed.id, operator: 'not_in' }], dateRange: { date_from: '-1d' }, trendsFilter: { display: 'BoldNumber' } });
check('cohort filters in insights (in / not in)', ci.results[0].aggregated_value === 2 && cn.results[0].aggregated_value === 0, [ci.results[0].aggregated_value, cn.results[0].aggregated_value]);
await api(`${A}/feature_flags`, 'POST', { key: 'buyers-only', filters: { groups: [{ properties: [{ type: 'cohort', key: 'id', value: buyers.id }], rollout_percentage: 100 }] } });
const sq = await api(`${A}/sql`, 'POST', { query: "SELECT event, count() AS n, count(DISTINCT person_id) AS persons FROM events WHERE event = '$pageview' GROUP BY event" });
check('SQL editor: aggregate over events with person count', sq.columns.join() === 'event,n,persons' && sq.results[0]?.[1] === 2 && sq.results[0]?.[2] === 1, sq);
const bad = await api(`${A}/sql`, 'POST', { query: 'DELETE FROM events' }).then(() => 0).catch((e: any) => e.status);
check('SQL editor rejects writes', bad === 400, bad);
const hm = await until('heatmap', () => api(`${A}/heatmaps?type=click&url_exact=${encodeURIComponent(siteUrl + '/')}&date_from=-1d`), (v: any) => v.results.length > 0);
check('heatmaps: posthog-js $$heatmap clicks aggregate for the page', hm.results.reduce((t: number, c: any) => t + c.count, 0) >= 1 && hm.results.every((c: any) => c.pointer_relative_x >= 0 && c.pointer_relative_x <= 1), hm.results.length);
const sd = await api(`${A}/scroll_depth?pathname=/&date_from=-1d`);
check('scroll depth from $prev_pageview_max_scroll_percentage', sd.pageviews >= 1 && sd.results[0].count === sd.pageviews, sd.pageviews);
const allSnaps = rec ? (await api(`${A}/session_recordings/${encodeURIComponent(rec.id)}/snapshots?paged=1`)) : { snapshots: [], next: null };
check('replay: console plugin events recorded', JSON.stringify(allSnaps.snapshots).includes('e2e-console-marker'), allSnaps.snapshots.filter((e: any) => e.type === 6).length);
check('replay: network timing plugin events recorded', allSnaps.snapshots.some((e: any) => e.type === 6 && e.data?.plugin === 'rrweb/network@1'), null);
const { key: phx } = await api('/api/personal_api_keys', 'POST', { label: 'e2e local eval' });
const local = new PostHog(project.api_token, { host: SITE, personalApiKey: phx, featureFlagsPollingInterval: 60000, flushAt: 1 });
await local.reloadFeatureFlags();
const le1 = await local.getFeatureFlag('new-dashboard', 'someone', { personProperties: { email: 'ada@example.com' }, onlyEvaluateLocally: true });
const le2 = await local.getFeatureFlag('new-dashboard', 'someone-else', { personProperties: { email: 'eve@example.org' }, onlyEvaluateLocally: true });
const le3 = await local.getFeatureFlag('buyers-only', 'user-42');
await local.shutdown();
const keys = await api('/api/personal_api_keys');
for (const k of keys.filter((k: any) => k.label === 'e2e local eval')) await api(`/api/personal_api_keys/${k.id}`, 'DELETE');
check('posthog-node local evaluation with a personal API key (definitions), behavioural-cohort flag falls back to /flags', le1 === true && le2 === false && le3 === true, [le1, le2, le3]);

// 6. the owner UI renders the data
const ui = await browser.newContext();
const up = await ui.newPage();
await up.goto(SITE + '/login');
await up.fill('input[type=email]', EMAIL); await up.fill('input[type=password]', PASSWORD); await up.click('button[type=submit]');
await up.waitForURL(/\/project\//);
await up.goto(`${SITE}/project/${project.id}/insights/new?kind=TrendsQuery`);
await up.waitForSelector('svg.chart', { timeout: 10000 }).catch(() => null);
check('insight editor draws a chart', (await up.locator('svg.chart').count()) === 1, null);
await up.goto(`${SITE}/project/${project.id}/persons`);
await up.waitForSelector('text=ada@example.com', { timeout: 10000 }).catch(() => null);
check('persons list shows the identified person', (await up.locator('text=ada@example.com').count()) > 0, null);
if (rec) {
  await up.goto(`${SITE}/project/${project.id}/replay/${encodeURIComponent(rec.id)}`);
  const played = await up.waitForSelector('.rr-player iframe', { timeout: 15000 }).then(() => true).catch(() => false);
  check('replay page mounts rrweb-player with the recording', played, null);
}
await up.goto(`${SITE}/project/${project.id}/experiments/${experiment.id}`);
check('experiment page shows the metric table', await up.waitForSelector('text=Chance to be best', { timeout: 10000 }).then(() => true).catch(() => false), null);
await up.goto(`${SITE}/project/${project.id}/surveys/${survey.id}`);
check('survey page shows the NPS', await up.waitForSelector('text=Promoters', { timeout: 10000 }).then(() => true).catch(() => false), null);

await up.goto(`${SITE}/project/${project.id}/actions`);
check('actions page lists the action', await up.waitForSelector('text=Clicked Buy', { timeout: 10000 }).then(() => true).catch(() => false), null);
await up.goto(`${SITE}/project/${project.id}/cohorts/${buyers.id}`);
check('cohort page lists its person', await up.waitForSelector('text=ada@example.com', { timeout: 10000 }).then(() => true).catch(() => false), null);
await up.goto(`${SITE}/project/${project.id}/sql#run`);
check('SQL page runs a query', await up.waitForSelector('table.sql-result tbody tr', { timeout: 15000 }).then(() => true).catch(() => false), null);
await up.goto(`${SITE}/project/${project.id}/heatmaps?url=${encodeURIComponent(siteUrl + '/')}&type=click&bg=iframe`);
check('heatmap page draws the overlay on the page', await up.waitForSelector('canvas.heatmap-canvas', { timeout: 15000 }).then(() => true).catch(() => false), null);
if (rec) {
  await up.goto(`${SITE}/project/${project.id}/replay/${encodeURIComponent(rec.id)}`);
  check('replay page shows the console panel', await up.waitForSelector('text=e2e-console-marker', { timeout: 15000 }).then(() => true).catch(() => false), null);
}

// 0.5: error tracking, usage, caps (quota_limited stops the real SDK)
const issues = await until('issues', () => api(`${A}/error_issues`), (v: any) => v.results.length >= 2, 20000);
const web = issues.results.find((i: any) => i.type === 'TypeError');
check('posthog-js exception autocapture groups an unhandled error into an issue', !!web && web.occurrences >= 1 && web.users === 1, issues.results);
check('posthog-node captureException groups into an issue', issues.results.some((i: any) => i.type === 'RangeError' && i.message === 'e2e node failure'), issues.results);
const issue = web ? await api(`${A}/error_issues/${web.id}`) : null;
check('issue detail has the stack trace, the person and the replay link', !!issue && issue.exception_list[0]?.stacktrace?.frames?.length > 0 && issue.occurrences_list[0]?.session_id && issue.exception_list[0].mechanism?.handled === false, issue?.occurrences_list?.[0]);
const usage = await api(`${A}/usage?days=7`);
check('usage counts events by type and replay', usage.month_to_date.events > 10 && usage.daily.some((d: any) => d.event === '$pageview') && usage.month_to_date.recordings >= 1 && usage.cost.lines.length > 5, usage.month_to_date);
await up.goto(`${SITE}/project/${project.id}/usage`);
check('usage page draws events per day and the cost estimate', await up.waitForSelector('text=Estimated Cloudflare cost', { timeout: 10000 }).then(() => true).catch(() => false) && (await up.locator('svg.chart').count()) >= 1, null);
if (web) { await up.goto(`${SITE}/project/${project.id}/errors/${web.id}`); check('issue page shows the stack trace', await up.waitForSelector('text=Stack trace', { timeout: 10000 }).then(() => true).catch(() => false) && (await up.locator('.frame').count()) > 0, null); }
// ---------- 0.6 ----------
const cfg = await api('/api/config');
// HTML fallback: deep links load the app; JSON clients get 404 JSON.
{
  const h = await fetch(`${SITE}/project/${project.id}/llm/traces/x`, { headers: { accept: 'text/html' } });
  const jn = await fetch(`${SITE}/project/${project.id}/llm/traces/x`, { headers: { accept: 'application/json' } });
  check('0.6 non-API GETs serve the app; JSON Accept gets 404', h.status === 200 && (h.headers.get('content-type') ?? '').includes('text/html') && jn.status === 404, [h.status, jn.status]);
}
// Server SDK exception lists (posthog-python, posthog-go, posthog-rs shapes) through /batch/.
const pyList = [{ type: 'ValueError', value: 'e2e python failure', mechanism: { type: 'generic', handled: false }, stacktrace: { type: 'raw', frames: [
  { platform: 'python', filename: 'app/views.py', abs_path: '/srv/app/views.py', function: 'post', module: 'app.views', lineno: 20, in_app: true, context_line: '    return place(cart)' },
  { platform: 'python', filename: 'app/orders.py', abs_path: '/srv/app/orders.py', function: 'place', module: 'app.orders', lineno: 7, in_app: true, pre_context: ['def place(cart):'], context_line: '    raise ValueError("e2e python failure")', post_context: [] }] } }];
const goList = [{ type: '*errors.errorString', value: 'e2e go failure', mechanism: { type: 'generic', handled: true }, stacktrace: { type: 'raw', frames: [{ platform: 'go', filename: 'main.go', function: 'main.main', lineno: 12, in_app: true }, { platform: 'go', filename: 'pay/pay.go', function: 'pay.Charge', lineno: 33, in_app: true }] } }];
const rsList = [{ type: 'std::io::Error', value: 'e2e rust failure', mechanism: { type: 'generic', handled: true }, stacktrace: { type: 'raw', frames: [{ platform: 'rust', filename: 'src/main.rs', function: 'svc::main', lineno: 5, in_app: true }, { platform: 'rust', filename: 'src/net.rs', function: 'svc::net::dial', lineno: 41, in_app: true }] } }];
const rule = await api(`${A}/error_grouping_rules`, 'POST', { field: 'value', match: 'contains', pattern: 'e2e grouped', key: 'e2e-grouped' });
const supp = await api(`${A}/error_suppression_rules`, 'POST', { type: 'OR', values: [{ key: '$exception_types', operator: 'exact', value: ['E2ENoise'] }] });
const remote = await (await fetch(`${SITE}/array/${project.api_token}/config`)).json();
check('0.6 suppression rules reach posthog-js remote config in its wire shape', JSON.stringify(remote.errorTracking?.suppressionRules) === JSON.stringify([{ type: 'OR', values: [{ key: '$exception_types', operator: 'exact', value: ['E2ENoise'], type: 'error_tracking_issue_property' }] }]), remote.errorTracking);
const batchExc = (did: string, list: any[], props: Record<string, unknown> = {}) => ({ event: '$exception', distinct_id: did, uuid: crypto.randomUUID(), properties: { $exception_list: list, ...props } });
const g1 = structuredClone(goList); g1[0].value = 'e2e grouped A'; const g2 = structuredClone(rsList); g2[0].value = 'e2e grouped B';
const JS0 = (FX as any).posthog_js_exceptions[0];
const br = await fetch(`${SITE}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: project.api_token, batch: [
  batchExc('py-e2e', pyList, { $lib: 'posthog-python', $release: 'py-1.0' }), batchExc('go-e2e', goList, { $lib: 'posthog-go' }), batchExc('rs-e2e', rsList, { $lib: 'posthog-rs' }),
  batchExc('g-1', g1), batchExc('g-2', g2), batchExc('noise', [{ type: 'E2ENoise', value: 'drop me' }]),
  { ...JS0, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), properties: { ...JS0.properties, $app_version: 'e2e-1.0', distinct_id: 'js-e2e', $session_id: undefined } }] }) });
check('0.6 /batch/ accepts server SDK exceptions', br.status === 200, br.status);
const all6 = await until('0.6 issues', () => api(`${A}/error_issues?status=`), (v: any) => ['ValueError', 'std::io::Error', '*errors.errorString'].every(t => v.results.some((i: any) => i.type === t && i.message?.startsWith('e2e '))) && v.results.some((i: any) => i.fingerprint === 'rule:e2e-grouped') && v.results.some((i: any) => i.message === 'Price must be a number, got string'), 20000);
const byType = (t: string, m: string) => all6.results.find((i: any) => i.type === t && i.message === m);
const pyI = byType('ValueError', 'e2e python failure'), goI = byType('*errors.errorString', 'e2e go failure'), rsI = byType('std::io::Error', 'e2e rust failure');
check('0.6 Python, Go and Rust stacks group with their own top frames', pyI?.top_frame === 'place (app/orders.py:7)' && goI?.top_frame === 'pay.Charge (pay/pay.go:33)' && rsI?.top_frame === 'svc::net::dial (src/net.rs:41)', [pyI?.top_frame, goI?.top_frame, rsI?.top_frame]);
check('0.6 release is read from $release', pyI?.first_seen_release === 'py-1.0', pyI);
const grouped = all6.results.find((i: any) => i.fingerprint === 'rule:e2e-grouped');
check('0.6 a grouping rule puts two different exceptions in one issue', grouped?.occurrences === 2, grouped);
check('0.6 suppressed exceptions never become issues', !all6.results.some((i: any) => i.type === 'E2ENoise'), null);
// Retroactive symbolication: the JS exception arrived before its map; upload the map for that release now.
const jsI = all6.results.find((i: any) => i.message === 'Price must be a number, got string' && i.first_seen_release === 'e2e-1.0');
const up6 = await api(`${A}/symbol_sets?url=${encodeURIComponent('http://172.17.0.1:8797/app.min.js')}&release=e2e-1.0`, 'PUT', (FX as any).app_min_js_map);
const jsD = jsI ? await api(`${A}/error_issues/${jsI.id}`) : null;
check('0.6 uploading a release source map re-symbolicates earlier exceptions', up6.resymbolicated?.symbolicated >= 1 && jsD?.top_frame === 'parsePrice (app-src.js:4)', [up6.resymbolicated, jsD?.top_frame]);
check('0.6 ?release= filters issues', (await api(`${A}/error_issues?status=&release=e2e-1.0`)).results.every((i: any) => i.id === jsI?.id), null);
// Merge, split, assign.
const merged = await api(`${A}/error_issues/${goI.id}/merge`, 'POST', { ids: [rsI.id] });
const mList = await api(`${A}/error_issues?status=`);
check('0.6 merge folds issues into one', merged.occurrences === 2 && !mList.results.some((i: any) => i.id === rsI.id), merged);
const mD = await api(`${A}/error_issues/${goI.id}`);
const rsFp = mD.fingerprints.find((f: any) => !f.primary)?.fingerprint;
const split = await api(`${A}/error_issues/${goI.id}/split`, 'POST', { fingerprint: rsFp });
check('0.6 split moves a fingerprint back to its own issue', split.split?.occurrences === 1 && split.issue?.occurrences === 1, split);
const asg = await api(`${A}/error_issues/${pyI.id}`, 'PATCH', { assignee: EMAIL });
check('0.6 assign an issue and filter by assignee', asg.assignee?.email === EMAIL.toLowerCase() && (await api(`${A}/error_issues?status=&assignee=me`)).results.map((i: any) => i.id).join() === pyI.id, asg.assignee);
// LLM analytics: posthog-node capture (what @posthog/ai sends), /i/v0/ai/batch, and the multipart /i/v0/ai endpoint.
const trace = 'e2e-trace-' + Date.now(); const span = crypto.randomUUID();
const ai = new PostHog(project.api_token, { host: SITE, flushAt: 1, flushInterval: 0 });
ai.capture({ distinct_id: 'llm-e2e', event: '$ai_generation', properties: { $ai_trace_id: trace, $ai_parent_id: span, $ai_span_name: 'answer', $ai_model: 'gpt-4o-mini', $ai_provider: 'openai', $ai_input_tokens: 1200, $ai_output_tokens: 300, $ai_latency: 1.2, $ai_http_status: 200, $ai_input: [{ role: 'user', content: 'e2e question' }], $ai_output_choices: [{ role: 'assistant', content: 'e2e answer' }] } });
await ai.shutdown();
const aiB = await fetch(`${SITE}/i/v0/ai/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: project.api_token, batch: [
  { event: '$ai_trace', distinct_id: 'llm-e2e', uuid: crypto.randomUUID(), properties: { $ai_trace_id: trace, $ai_span_name: 'e2e-bot', $ai_latency: 2 } },
  { event: '$ai_span', distinct_id: 'llm-e2e', uuid: crypto.randomUUID(), properties: { $ai_trace_id: trace, $ai_span_id: span, $ai_parent_id: trace, $ai_span_name: 'plan', $ai_latency: 1.5 } },
  { event: 'not_ai', distinct_id: 'llm-e2e', properties: {} }] }) });
const fd = new FormData();
fd.append('event', new Blob([JSON.stringify({ event: '$ai_generation', distinct_id: 'llm-e2e', uuid: crypto.randomUUID(), properties: { $ai_trace_id: trace } })], { type: 'application/json' }), 'event');
fd.append('event.properties', new Blob([JSON.stringify({ $ai_parent_id: span, $ai_span_name: 'critique', $ai_model: 'claude-haiku-4-5', $ai_provider: 'anthropic', $ai_input_tokens: 800, $ai_output_tokens: 90, $ai_latency: 0.6, $ai_is_error: true, $ai_error: 'overloaded_error', $ai_http_status: 529 })], { type: 'application/json' }), 'event.properties');
const aiM = await fetch(`${SITE}/i/v0/ai`, { method: 'POST', headers: { authorization: `Bearer ${project.api_token}` }, body: fd });
check('0.6 AI endpoints accept batch and multipart', aiB.status === 200 && aiM.status === 200, [aiB.status, aiM.status]);
const ov = await until('llm overview', () => api(`${A}/llm/overview`), (v: any) => v.totals.generations >= 2, 15000);
check('0.6 LLM overview: generations, tokens, cost, latency, errors, models', ov.totals.generations === 2 && ov.totals.input_tokens === 2000 && ov.totals.cost_usd > 0 && ov.totals.latency_p95_ms > 0 && ov.totals.errors === 1 && ov.models.length === 2, ov.totals);
const trs = await api(`${A}/llm/traces?search=e2e-bot`);
check('0.6 LLM traces list filters', trs.total === 1 && trs.results[0].status === 'error' && (await api(`${A}/llm/traces?provider=anthropic`)).total === 1, trs.results[0]);
const td = await api(`${A}/llm/traces/${encodeURIComponent(trace)}`);
check('0.6 LLM trace detail: span tree with generations, inputs and outputs', td.tree.length === 1 && td.tree[0].name === 'plan' && td.tree[0].children.length === 2 && td.tree[0].children.some((c: any) => c.output?.[0]?.content === 'e2e answer'), td.tree);
check('0.6 non-AI events on the AI endpoint are dropped', !(await api(`${A}/events?event=not_ai&limit=5`)).results.length, null);
await up.goto(`${SITE}/project/${project.id}/llm`);
check('0.6 LLM analytics page shows the overview', await up.waitForSelector('h2:has-text("Models")', { timeout: 10000 }).then(() => true).catch(() => false), null);
await up.goto(`${SITE}/project/${project.id}/llm/traces/${encodeURIComponent(trace)}`);
check('0.6 trace page draws the waterfall', await up.waitForSelector('.wf-bar', { timeout: 10000 }).then(() => true).catch(() => false) && (await up.locator('.wf-row').count()) === 3, null);
await up.goto(`${SITE}/project/${project.id}/errors/${pyI.id}`);
check('0.6 issue page shows releases, assignee and fingerprints', await up.waitForSelector('#fingerprints', { timeout: 10000 }).then(() => true).catch(() => false) && (await up.locator('text=py-1.0').count()) > 0, null);
// Usage counters.
const u6 = await until('usage counters', () => api(`${A}/usage`), (v: any) => v.month_to_date.flag_requests > 0 && v.month_to_date.api_requests > 0, 10000);
check('0.6 usage counts flag/decide, config and API requests and suppressed exceptions', u6.month_to_date.flag_requests > 0 && u6.month_to_date.api_requests > 0 && u6.month_to_date.suppressed_exceptions === 1, u6.month_to_date);
check('0.6 cost headline is the list price with an included-allowance alternative', u6.cost.list_usd >= u6.cost.after_included_usd && u6.cost.notes.join(' ').includes('only workload'), u6.cost.notes);
// Cold Trends degrade without a cold tier.
const coldR = await fetch(`${SITE}${A}/query`, { method: 'POST', headers: { origin: SITE, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ source: 'cold', query: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview' }] } }) });
check('0.6 cold Trends answers (or says the cold tier is off)', cfg.cold_tier ? coldR.status === 200 : coldR.status === 400 && (await coldR.text()).includes('not configured'), coldR.status);
// Public demo (only when the instance runs with PUBLIC_DEMO=1).
if (cfg.public_demo) {
  await api(A, 'PATCH', { public_demo: true });
  const anon = async (path: string, init: RequestInit = {}) => fetch(SITE + path, { ...init, headers: { origin: SITE, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const me = await (await anon('/api/me')).json();
  const ps = await (await anon('/api/projects')).json();
  const mine = ps.find((x: any) => x.id === project.id);
  check('0.6 public demo: signed-out visitors see demo projects with the key masked', me.demo === true && !!mine && mine.api_token !== project.api_token && !JSON.stringify(ps).includes(EMAIL), [me, mine?.api_token]);
  const w = await anon(`${A}/insights`, { method: 'POST', body: JSON.stringify({ name: 'x', query: {} }) });
  const q = await anon(`${A}/query`, { method: 'POST', body: JSON.stringify({ query: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview' }] } }) });
  check('0.6 public demo: mutations get 403 demo_read_only, queries work', w.status === 403 && (await w.json()).error === 'demo_read_only' && q.status === 200, [w.status, q.status]);
  const stranger = await anon('/api/signup', { method: 'POST', body: JSON.stringify({ email: `stranger-${Date.now()}@example.invalid`, password: 'correct horse battery staple' }) });
  check('0.6 public demo: ALLOWED_EMAILS still blocks strangers', stranger.status === 403, stranger.status);
  const vctx = await browser.newContext(); const vp = await vctx.newPage();
  await vp.goto(`${SITE}/project/${project.id}/errors`);
  const banner = await vp.waitForSelector('text=Read-only public demo', { timeout: 10000 }).then(() => true).catch(() => false);
  check('0.6 public demo: the UI shows the banner and disables write actions', banner && (await vp.locator('button:has-text("Merge selected")').isDisabled().catch(() => false)), null);
  await vctx.close();
  await api(A, 'PATCH', { public_demo: false });
} else {
  check('0.6 public demo off: signed-out API calls get 401', (await fetch(`${SITE}/api/me`)).status === 401, null);
}
await api(`${A}/error_grouping_rules/${rule.id}`, 'DELETE'); await api(`${A}/error_suppression_rules/${supp.id}`, 'DELETE');

const capped = await api(A, 'PATCH', { limits: { events_monthly: 1, over_cap: 'drop' } });
check('a cap below usage marks the project capped at once', capped.cap_state.events === true, capped.cap_state);
// Other isolates keep the project row for up to 10 s (design.md "Usage limits"), so wait for the edge to see the cap.
const cappedAt = Date.now();
await until('edge cap state', async () => (await fetch(`${SITE}/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: project.api_token, event: 'cap probe', distinct_id: 'cap-probe', properties: {} }) })).text(), t => t.includes('quota_limited'), 15000);
if (Date.now() - cappedAt < 11000) await sleep(11000 - (Date.now() - cappedAt));
const replies: string[] = []; const sent: string[] = [];
p.on('response', async r => { const u = new URL(r.url()); if (u.origin === SITE && /^\/(e|i\/v0\/e)\/?$/.test(u.pathname)) replies.push(await r.text().catch(() => '')); });
p.on('request', r => { const u = new URL(r.url()); if (u.origin === SITE && /^\/(e|i\/v0\/e)\/?$/.test(u.pathname)) sent.push(r.postData() ?? ''); });
await p.click('#cta');
await until('quota reply', async () => replies.length, n => n > 0, 10000); await sleep(1500); // posthog-js flushes its queue every few seconds
const limitedReply = replies.find(x => x.includes('quota_limited'));
const before = sent.length;
await p.click('#cta'); await p.click('#pricing'); await sleep(5000);
check('capture answers quota_limited and posthog-js stops sending', !!limitedReply && limitedReply.includes('"events"') && sent.length === before, { replies, before, after: sent.length });
await api(A, 'PATCH', { limits: { events_monthly: null } });
await sleep(2500); await fetch(`${SITE}/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: project.api_token, event: 'meter flush', distinct_id: 'x', properties: {} }) });
const dropped = await until('dropped past cap', () => api(`${A}/usage`), (v: any) => v.dropped_past_cap.events > 0 && v.dropped_past_cap.requests > 0, 10000);
check('0.6 usage shows events and requests dropped past the cap', dropped.dropped_past_cap.events > 0 && dropped.dropped_past_cap.requests > 0, dropped.dropped_past_cap);

await browser.close(); site.close();
await api(A, 'DELETE');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
