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

// 1. account and a fresh project
try { await api('/api/signup', 'POST', { email: EMAIL, password: PASSWORD, name: 'E2E' }); } catch (e: any) { if (e.status !== 403 && e.status !== 409) throw e; }
await api('/api/login', 'POST', { email: EMAIL, password: PASSWORD });
const project = await api('/api/projects', 'POST', { name: `e2e ${new Date().toISOString()}`, timezone: 'UTC' });
const A = `/api/projects/${project.id}`;
await api(`${A}/feature_flags`, 'POST', { key: 'new-dashboard', filters: { groups: [{ properties: [{ key: 'email', value: ['ada@example.com'], operator: 'exact', type: 'person' }], rollout_percentage: 100 }] } });
await api(`${A}/feature_flags`, 'POST', { key: 'checkout-test', filters: { groups: [{ properties: [], rollout_percentage: 100 }], multivariate: { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] }, payloads: { test: '{"color":"green"}', control: '{"color":"blue"}' } } });

// 2. a customer site on another origin with the install snippet from the Settings page
const snippet = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;
const page = (title: string) => `<!doctype html><html><head><title>${title}</title><script>${snippet}
posthog.init(${JSON.stringify(project.api_token)}, { api_host: ${JSON.stringify(SITE)}, person_profiles: 'identified_only', opt_out_useragent_filter: true })</script></head>
<body><h1>${title}</h1>
<button id="cta" onclick="posthog.capture('clicked_cta',{plan:'pro',price:12})">Buy</button>
<button id="identify" onclick="posthog.identify('user-42',{email:'ada@example.com'},{first_plan:'free'})">Identify</button>
<button id="group" onclick="posthog.group('company','acme',{name:'Acme Inc'})">Group</button>
<button id="flags" onclick="posthog.reloadFeatureFlags();posthog.onFeatureFlags(()=>{document.getElementById('out').textContent=JSON.stringify([posthog.isFeatureEnabled('new-dashboard'),posthog.getFeatureFlag('checkout-test'),posthog.getFeatureFlagPayload('checkout-test')])})">Flags</button>
<a id="next" href="/page2">Next</a><pre id="out"></pre></body></html>`;
const site = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(page(q.url === '/page2' ? 'Page 2' : 'Home')); });
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
const p = await ctx.newPage();
const capturePosts: string[] = [];
p.on('request', r => { const u = new URL(r.url()); if (u.origin === SITE && r.method() === 'POST') capturePosts.push(u.pathname); });
await p.goto(siteUrl + '/');
await p.waitForFunction(() => (window as any).posthog?.__loaded);
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
await p.click('#next');
await p.waitForURL(/page2/);
await p.waitForFunction(() => (window as any).posthog?.__loaded);
await sleep(1500);
await p.evaluate(() => (window as any).posthog?._requestQueue?.flush?.());
await sleep(1500);
check('posthog-js posts to /e/ or /i/v0/e/ and /flags/', capturePosts.some(x => /^\/(e|i\/v0\/e)\/?$/.test(x)) && capturePosts.some(x => x.startsWith('/flags')), capturePosts);

// 3. posthog-node over /i/v1/analytics/events
const node = new PostHog(project.api_token, { host: SITE, flushAt: 1, flushInterval: 0 });
node.capture({ distinctId: 'server-1', event: 'order_completed', properties: { amount: 49.5, $set: { plan: 'team' } } });
node.identify({ distinctId: 'server-1', properties: { email: 'server@example.com' } });
node.alias({ distinctId: 'server-1', alias: 'legacy-9' });
const nodeFlag = (await node.evaluateFlags('server-1')).getFlag('checkout-test');
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

await browser.close(); site.close();
await api(A, 'DELETE');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
