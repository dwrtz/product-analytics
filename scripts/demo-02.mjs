// Adds the 0.2 demo data to a project (for screenshots): session recordings from real posthog-js runs in Chromium, an
// experiment on a multivariate flag with seeded exposures, and a launched NPS survey with seeded answers.
// Usage: node scripts/demo-02.mjs <site> <email> <password> <projectId>
import http from 'node:http';
import { chromium } from 'playwright';
const [site, email, password, pid] = process.argv.slice(2);
let cookie = '';
const call = async (path, method = 'GET', body) => {
  const r = await fetch(site + path, { method, headers: { origin: site, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`); return data;
};
await call('/api/login', 'POST', { email, password });
const A = `/api/projects/${pid}`;
// Record every demo visitor: new projects default to a replay sample rate below 1 (0.5), which could skip all three.
const cur = await call(A);
const p = await call(A, 'PATCH', { session_recording: true, replay_config: { ...(cur.replay_config ?? {}), sample_rate: 1, minimum_duration_ms: 0 } });
const ONLY_REC = process.env.ONLY_REC === '1'; // re-record the browser sessions only
const flags = await call(`${A}/feature_flags`);
if (!flags.some(f => f.key === 'checkout-button')) await call(`${A}/feature_flags`, 'POST', { key: 'checkout-button', name: 'Checkout button colour', active: false, filters: { groups: [{ properties: [], rollout_percentage: 100 }], multivariate: { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'green', rollout_percentage: 50 }] } } });
const exp = ONLY_REC ? (await call(`${A}/experiments`))[0] : await call(`${A}/experiments`, 'POST', { name: 'Green checkout button', feature_flag_key: 'checkout-button', metrics: [
  { kind: 'funnel', name: 'Purchase conversion', series: [{ event: 'checkout_started' }, { event: 'purchase' }] },
  { kind: 'continuous', name: 'Revenue per person', event: { event: 'purchase' }, math_property: 'amount' }] });
if (!ONLY_REC) await call(`${A}/experiments/${exp.id}`, 'PATCH', { action: 'launch' });
const survey = ONLY_REC ? (await call(`${A}/surveys`))[0] : await call(`${A}/surveys`, 'POST', { name: 'Net Promoter Score', type: 'popover', conditions: { events: { values: [{ name: 'opened_pricing' }] } }, questions: [
  { type: 'rating', id: 'nps', question: 'How likely are you to recommend Acme to a friend?', display: 'number', scale: 10, lowerBoundLabel: 'Unlikely', upperBoundLabel: 'Very likely' },
  { type: 'single_choice', id: 'source', question: 'How did you hear about us?', choices: ['Search', 'Friend', 'Social', 'Ad'] },
  { type: 'open', id: 'better', question: 'What should we improve?', optional: true }] });
if (!ONLY_REC) await call(`${A}/surveys/${survey.id}`, 'PATCH', { action: 'launch' });
await new Promise(r => setTimeout(r, 1500));

// Seeded exposures and outcomes, timestamped after the launch.
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const t0 = Date.now() - 1000; const events = []; let k = 0;
const ts = () => new Date(t0 - 60_000 + (k++) * 3).toISOString();
const later = () => new Date(t0 + (k++) * 3).toISOString();
const comments = ['Faster shipping please', 'Love the new checkout', 'More payment options', 'Search could be better', 'Great support team', 'Dark mode!', 'Cheaper delivery'];
for (let i = 0; i < 640; i++) {
  const did = `exp-user-${i}@example.com`; const v = i % 2 ? 'green' : 'control';
  events.push({ event: '$feature_flag_called', distinct_id: did, timestamp: later(), properties: { $feature_flag: 'checkout-button', $feature_flag_response: v } });
  if (rnd() < 0.55) {
    events.push({ event: 'checkout_started', distinct_id: did, timestamp: later(), properties: {} });
    if (rnd() < (v === 'green' ? 0.42 : 0.31)) events.push({ event: 'purchase', distinct_id: did, timestamp: later(), properties: { amount: Math.round(20 + rnd() * (v === 'green' ? 90 : 80)) } });
  }
  if (i < 120) {
    events.push({ event: 'survey shown', distinct_id: did, timestamp: later(), properties: { $survey_id: survey.id, $survey_name: survey.name } });
    if (rnd() < 0.7) {
      const score = Math.min(10, Math.max(0, Math.round(7.6 + (rnd() - 0.5) * 7)));
      const src = ['Search', 'Search', 'Friend', 'Social', 'Ad'][Math.floor(rnd() * 5)];
      const props = { $survey_id: survey.id, $survey_name: survey.name, $survey_submission_id: crypto.randomUUID(), $survey_completed: true, $survey_response_nps: score, $survey_response_source: src };
      if (rnd() < 0.4) props.$survey_response_better = comments[Math.floor(rnd() * comments.length)];
      events.push({ event: 'survey sent', distinct_id: did, timestamp: later(), properties: props, $set: { [`$survey_responded/${survey.id}`]: true } });
    } else events.push({ event: 'survey dismissed', distinct_id: did, timestamp: later(), properties: { $survey_id: survey.id, $survey_name: survey.name } });
  }
}
void ts;
for (let i = 0; i < (ONLY_REC ? 0 : events.length); i += 500) {
  const r = await fetch(`${site}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: p.api_token, batch: events.slice(i, i + 500).map(e => ({ ...e, uuid: crypto.randomUUID() })) }) });
  if (!r.ok) throw new Error(`batch ${r.status}`);
}

// Real recordings: posthog-js on a small store page, three visitors.
const page = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:0;background:#f8fafc}header{background:#1e293b;color:#fff;padding:14px 24px;font-weight:700}main{padding:24px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px}button{background:#16a34a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px}input{padding:8px;border:1px solid #cbd5e1;border-radius:6px}</style>
<script src="${site}/static/array.js"></script><script>posthog.init(${JSON.stringify(p.api_token)}, { api_host: ${JSON.stringify(site)}, person_profiles: 'identified_only', opt_out_useragent_filter: true })</script></head>
<body><header>Acme Store — ${title}</header><main>${['Trail shoes', 'Rain jacket', 'Day pack'].map((n, i) => `<div class="card"><h3>${n}</h3><p>$${[89, 129, 59][i]}</p><button id="buy${i}" onclick="posthog.capture('checkout_started')">Add to cart</button></div>`).join('')}
<div class="card"><h3>Newsletter</h3><input id="email" placeholder="you@example.com"> <button id="sub" onclick="posthog.identify(document.getElementById('email').value,{email:document.getElementById('email').value})">Subscribe</button></div>
<div class="card"><h3>Pricing</h3><button id="pricing" onclick="posthog.capture('opened_pricing')">See plans</button></div></main></body></html>`;
const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(page(q.url === '/cart' ? 'Cart' : 'Home')); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}`;
const b = await chromium.launch();
for (const [i, who] of ['maria@example.com', 'chen@example.com', 'sam@example.com'].entries()) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 700 } }); const pg = await ctx.newPage();
  await pg.goto(url + '/'); await pg.waitForFunction(() => window.posthog?.__loaded); await pg.waitForTimeout(1500);
  await pg.mouse.move(200, 200); await pg.click(`#buy${i}`); await pg.waitForTimeout(800);
  await pg.fill('#email', who); await pg.waitForTimeout(400); await pg.click('#sub'); await pg.waitForTimeout(800);
  await pg.click('#pricing');
  const shown = await pg.waitForSelector('.question-0-rating-9', { timeout: 8000 }).then(() => true).catch(() => false);
  if (shown) { await pg.click(`.question-0-rating-${[9, 10, 7][i]}`); await pg.click('.form-submit'); await pg.click('#surveyQuestion1Choice1'); await pg.click('.form-submit'); await pg.fill('textarea', ['Love it', 'More colours', 'Faster delivery'][i]); await pg.click('.form-submit'); }
  await pg.waitForTimeout(1500); await pg.goto(url + '/cart'); await pg.waitForTimeout(6500);
  await ctx.close();
}
await b.close(); srv.close();
console.log(JSON.stringify({ experiment: exp.id, survey: survey.id }));
