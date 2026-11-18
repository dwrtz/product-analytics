// 0.3 demo data and screenshots: real posthog-js visitors on a store page (heatmaps, scroll depth, console and network
// capture in replays), actions, cohorts, a cohort-targeted flag and survey, then screenshots of the 0.3 screens.
// Usage: node scripts/shots-03.mjs <site> <email> <password> <projectId> <outDir>
import http from 'node:http';
import { chromium } from 'playwright';
const [site, email, password, pid, out] = process.argv.slice(2);
let cookie = '';
const call = async (path, method = 'GET', body) => {
  const r = await fetch(site + path, { method, headers: { origin: site, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`); return data;
};
await call('/api/login', 'POST', { email, password });
const A = `/api/projects/${pid}`;
const p = await call(A, 'PATCH', { session_recording: true, heatmaps: true, replay_config: { console: true, network: { timing: true }, sample_rate: 1, minimum_duration_ms: 2000, canvas: { enabled: false, fps: 4, quality: 0.4 }, masking: { mask_all_inputs: true } } });
const HOST = 'acme-store.test';
const page = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:0;background:#f8fafc;color:#0f172a}header{background:#1e293b;color:#fff;padding:14px 24px;font-weight:700;display:flex;justify-content:space-between}nav a{color:#cbd5e1;margin-left:16px;text-decoration:none}.hero{padding:40px 24px;background:linear-gradient(90deg,#e0f2fe,#f0fdf4)}.hero h1{margin:0 0 8px}main{padding:24px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px}button{background:#16a34a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px;cursor:pointer}.ghost{background:#e2e8f0;color:#0f172a}footer{padding:24px;color:#64748b;height:700px}</style>
<script src="${site}/static/array.js"></script><script>posthog.init(${JSON.stringify(p.api_token)}, { api_host: ${JSON.stringify(site)}, person_profiles: 'identified_only', opt_out_useragent_filter: true })</script></head>
<body><header>Acme Store<nav><a href="/">Shop</a><a id="nav-pricing" href="/pricing">Pricing</a><a href="/help">Help</a></nav></header>
<section class="hero"><h1>${title === 'Home' ? 'Gear for every trail' : title}</h1><p>Free returns for 60 days.</p><button id="hero-cta" class="signup" onclick="posthog.capture('signup_started')">Create account</button> <button class="ghost" id="learn">Learn more</button></section>
<main>${['Trail shoes', 'Rain jacket', 'Day pack'].map((n, i) => `<div class="card"><h3>${n}</h3><p>$${[89, 129, 59][i]}</p><button id="buy${i}" class="add" onclick="posthog.capture('checkout_started');fetch('/api/cart?item=${i}').catch(()=>{})">Add to cart</button></div>`).join('')}</main>
<footer>© Acme · <a href="/help">Contact</a></footer>
<script>setTimeout(()=>{console.log('cart ready');if(location.pathname==='/pricing')console.error('Price API timeout after 3000ms')},800)</script></body></html>`;
const srv = http.createServer((q, s) => { if (q.url.startsWith('/api/')) { s.writeHead(200, { 'content-type': 'application/json' }); return s.end('{"ok":true}'); } s.writeHead(200, { 'content-type': 'text/html' }); s.end(page(q.url === '/pricing' ? 'Pricing' : 'Home')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port; const url = `http://${HOST}:${port}`;
const b = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const people = ['maria', 'chen', 'sam', 'olu', 'ines', 'kai', 'noor', 'tom', 'lea', 'raj', 'ana', 'ben'];
if (process.env.SKIP_VISITS !== '1') for (const [i, who] of people.entries()) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 } }); const pg = await ctx.newPage();
  await pg.goto(url + '/'); await pg.waitForFunction(() => window.posthog?.__loaded); await pg.waitForTimeout(1200);
  const clickEl = async (sel) => { const bb = await pg.locator(sel).boundingBox(); if (bb) await pg.mouse.click(bb.x + bb.width * (0.2 + rnd() * 0.6), bb.y + bb.height * (0.2 + rnd() * 0.6)); await pg.waitForTimeout(250); };
  for (let k = 0; k < 2 + Math.floor(rnd() * 3); k++) await clickEl(['#hero-cta', '#buy0', '#buy1', '#buy2', '#hero-cta', '#learn'][Math.floor(rnd() * 6)]);
  if (i % 4 === 0) { const bb = await pg.locator('h1').boundingBox(); for (let k = 0; k < 4; k++) { await pg.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5); await pg.waitForTimeout(90); } } // rage clicks on the headline
  await pg.mouse.wheel(0, 200 + Math.floor(rnd() * 700)); await pg.waitForTimeout(500);
  if (i % 2 === 0) await pg.evaluate(w => window.posthog.identify(w + '@example.com', { email: w + '@example.com', plan: ['free', 'pro'][w.length % 2] }), who);
  await pg.waitForTimeout(5500);
  await pg.goto(url + '/pricing'); await pg.waitForTimeout(2500);
  await ctx.close();
}
await new Promise(r => setTimeout(r, 2000));
// actions, cohorts, flag and survey targeting
const has = async (path, name) => (await call(`${A}/${path}`)).find(x => x.name === name || x.key === name);
const addToCart = await has('actions', 'Added to cart') ?? await call(`${A}/actions`, 'POST', { name: 'Added to cart', description: 'Any Add to cart button', steps: [{ event: '$autocapture', selector: 'button.add', text: 'Add to cart' }, { event: 'checkout_started' }] });
const signup = await has('actions', 'Clicked sign-up') ?? await call(`${A}/actions`, 'POST', { name: 'Clicked sign-up', steps: [{ event: '$autocapture', selector: '#hero-cta' }] });
const pricing = await has('actions', 'Viewed pricing') ?? await call(`${A}/actions`, 'POST', { name: 'Viewed pricing', steps: [{ event: '$pageview', url: '/pricing', url_matching: 'contains' }] });
const shoppers = await has('cohorts', 'Shoppers (cart 2+ times, 30 days)') ?? await call(`${A}/cohorts`, 'POST', { name: 'Shoppers (cart 2+ times, 30 days)', description: 'Added to cart at least twice in the last 30 days', filters: { properties: { type: 'OR', values: [{ type: 'AND', values: [{ type: 'behavioral', key: addToCart.id, event_type: 'actions', value: 'performed_event_multiple', operator: 'gte', operator_value: 2, time_value: 30, time_interval: 'day' }, { type: 'person', key: 'email', value: '@example.com', operator: 'icontains' }] }] } } });
const pros = await has('cohorts', 'Pro plan') ?? await call(`${A}/cohorts`, 'POST', { name: 'Pro plan', filters: { properties: { type: 'OR', values: [{ type: 'AND', values: [{ type: 'person', key: 'plan', value: ['pro'], operator: 'exact' }] }] } } });
const beta = await has('cohorts', 'Beta testers') ?? await call(`${A}/cohorts`, 'POST', { name: 'Beta testers', is_static: true, csv: 'email\nmaria@example.com\nsam@example.com\nines@example.com\n' });
await call(`${A}/cohorts/${shoppers.id}/calculate`, 'POST', {});
const flag = await has('feature_flags', 'new-cart') ?? await call(`${A}/feature_flags`, 'POST', { key: 'new-cart', name: 'Redesigned cart for shoppers and beta testers', ensure_experience_continuity: true, filters: { groups: [{ properties: [{ type: 'cohort', key: 'id', value: shoppers.id }], rollout_percentage: 100 }, { properties: [{ type: 'cohort', key: 'id', value: beta.id }], rollout_percentage: 50 }] } });
const sv = await has('surveys', 'Cart feedback') ?? await call(`${A}/surveys`, 'POST', { name: 'Cart feedback', type: 'popover', enable_partial_responses: true, iteration_count: 4, iteration_frequency_days: 90,
  targeting_flag_filters: { groups: [{ properties: [{ type: 'cohort', key: 'id', value: shoppers.id }, { type: 'person', key: 'plan', value: ['pro'], operator: 'exact' }], rollout_percentage: 50 }] },
  conditions: { url: '/pricing', urlMatchType: 'icontains', selector: '#hero-cta', deviceTypes: ['Desktop'], deviceTypesMatchType: 'exact', seenSurveyWaitPeriodInDays: 14, actions: { values: [{ id: addToCart.id }] } },
  questions: [{ type: 'rating', id: 'ease', question: 'How easy was it to add items to your cart?', display: 'number', scale: 5, lowerBoundLabel: 'Hard', upperBoundLabel: 'Easy' }, { type: 'open', id: 'why', question: 'What would make it easier?', optional: true }] });
void flag; void pros; void signup; void pricing;
const ins = await call(`${A}/insights`, 'POST', { name: 'Add to cart by shoppers', query: { kind: 'TrendsQuery', series: [{ kind: 'ActionsNode', id: addToCart.id, math: 'total' }, { kind: 'ActionsNode', id: signup.id, math: 'dau' }], interval: 'hour', dateRange: { date_from: '-24h' }, trendsFilter: { display: 'ActionsBar' }, properties: [{ type: 'cohort', key: 'id', value: beta.id, operator: 'not_in' }] } });

// screenshots
const desk = await b.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
const lp = await desk.newPage(); await lp.goto(site + '/login'); await lp.fill('input[type=email]', email); await lp.fill('input[type=password]', password); await lp.click('button[type=submit]'); await lp.waitForURL(/project/); await lp.close();
const shoot = async (path, file, wait = 1200, act, full = false) => {
  const pg = await desk.newPage(); await pg.goto(site + path); await pg.waitForLoadState('networkidle'); if (act) await act(pg); await pg.waitForTimeout(wait);
  await pg.screenshot({ path: `${out}/${file}`, fullPage: full }); await pg.close(); console.log('shot', file);
};
const P = `/project/${pid}`;
await shoot(`${P}/actions`, 'actions.png');
await shoot(`${P}/actions/${addToCart.id}`, 'action-edit.png', 2000, null, true);
await shoot(`${P}/cohorts`, 'cohorts.png');
await shoot(`${P}/cohorts/${shoppers.id}`, 'cohort-edit.png', 1500, null, true);
await shoot(`${P}/cohorts/${beta.id}`, 'cohort-static.png', 1200);
await shoot(`${P}/insights/${ins.short_id}`, 'insight-actions-cohort.png', 2000);
await shoot(`${P}/sql`, 'sql.png', 600, async (pg) => { await pg.fill('textarea.sql', "SELECT properties.$pathname AS path, count() AS views, uniq(distinct_id) AS visitors,\n  countIf(event = '$autocapture') AS clicks\nFROM events\nWHERE timestamp > now() - INTERVAL 1 DAY\nGROUP BY path\nORDER BY views DESC\nLIMIT 20"); await pg.click('button.primary'); await pg.waitForSelector('table.sql-result tbody tr', { timeout: 15000 }); });
await shoot(`${P}/heatmaps?url=${encodeURIComponent(url + '/')}&type=click&bg=iframe&width=1280&date_from=-24h`, 'heatmap-clicks.png', 2500, async (pg) => { await pg.waitForSelector('canvas.heatmap-canvas', { timeout: 15000 }); });
await shoot(`${P}/heatmaps?url=${encodeURIComponent(url + '/')}&type=click&bg=recording&width=1280&date_from=-24h`, 'heatmap-recording-bg.png', 3500, async (pg) => { await pg.waitForSelector('canvas.heatmap-canvas', { timeout: 15000 }); });
await shoot(`${P}/heatmaps?url=${encodeURIComponent(url + '/')}&type=scrolldepth&date_from=-24h`, 'scroll-depth.png', 1500);
const recs = (await call(`${A}/session_recordings`)).results; const rec = recs.find(r => r.start_url?.includes(HOST)) ?? recs[0];
await shoot(`${P}/replay/${encodeURIComponent(rec.id)}`, 'replay-console-network.png', 1500, async (pg) => {
  await pg.waitForSelector('.rr-player iframe', { timeout: 15000 }); await pg.locator('details.devtools').nth(1).evaluate(d => d.open = true);
  await pg.locator('text=cart ready').first().click().catch(() => {}); }, true);
await shoot(`${P}/settings`, 'settings-replay-config.png', 800, async (pg) => { await pg.locator('#replay-settings').scrollIntoViewIfNeeded(); });
await shoot(`${P}/surveys/${sv.id}/edit`, 'survey-targeting.png', 800, null, true);
const fl = (await call(`${A}/feature_flags`)).find(f => f.key === 'new-cart');
await shoot(`${P}/feature_flags/${fl.id}`, 'flag-cohorts.png', 800, null, true);
await b.close(); srv.close();
