// End to end against a running instance (npm run dev): the real posthog-js snippet in Chromium and posthog-node send
// events; the owner API and UI then show the right persons, flags and insight numbers. Usage:
//   SITE=http://localhost:8787 E2E_EMAIL=… E2E_PASSWORD=… npm run e2e
import http from 'node:http';
import { chromium } from 'playwright';
import { PostHog } from 'posthog-node';

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
const capped = await api(A, 'PATCH', { limits: { events_monthly: 1, over_cap: 'drop' } });
check('a cap below usage marks the project capped at once', capped.cap_state.events === true, capped.cap_state);
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

await browser.close(); site.close();
await api(A, 'DELETE');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
