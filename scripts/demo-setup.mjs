#!/usr/bin/env node
// Builds the public demo project ("Acme Store") with data on every screen (0.6): 58 days of traffic, insights, a
// dashboard and flags; session recordings, an experiment and a survey (scripts/demo-02.mjs, needs Playwright);
// error tracking with real posthog-js stacks across three releases (source maps uploaded per release AFTER the
// exceptions arrive, so retroactive symbolication runs), pre-symbolicated Python, Go and Rust stacks, a merged issue,
// a grouping rule, a suppression rule and an assignee; usage including events and requests dropped past a cap; LLM
// traces, generations, spans and embeddings across OpenAI, Anthropic, Google and xAI models. Finally marks the project
// public_demo so signed-out visitors can browse it read-only when the instance runs with PUBLIC_DEMO=1.
//
// Works against wrangler dev or a live URL. All data is synthetic. The password comes from PA_DEMO_PASSWORD (or the
// third argument, which shows in `ps`).
//   PA_DEMO_PASSWORD=... node scripts/demo-setup.mjs <site> <email> [password] [--no-browser] [--no-traffic]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const argv = process.argv.slice(2); const flags = new Set(argv.filter(a => a.startsWith('--'))); const pos = argv.filter(a => !a.startsWith('--'));
const [site0, email, pw] = pos; const password = process.env.PA_DEMO_PASSWORD || pw;
if (!site0 || !email || !password) { console.error('usage: PA_DEMO_PASSWORD=... node scripts/demo-setup.mjs <site> <email> [--no-browser] [--no-traffic]'); process.exit(2); }
const site = site0.replace(/\/+$/, '');
let cookie = '';
const call = async (path, method = 'GET', body, okStatus = []) => {
  const go = () => fetch(site + path, { method, headers: { origin: site, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  // A kept-alive socket can be closed by the server while a long step runs; retry once on a network error.
  const r = await go().catch(async () => { await sleep(500); return go(); });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({})); if (!r.ok && !okStatus.includes(r.status)) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error('[demo]', ...a);
try { await call('/api/login', 'POST', { email, password }); } catch { await call('/api/signup', 'POST', { email, password, name: 'Ada' }); await call('/api/login', 'POST', { email, password }); }
let p = (await call('/api/projects')).find(x => x.name === 'Acme Store');
const fresh = !p;
if (!p) p = await call('/api/projects', 'POST', { name: 'Acme Store', timezone: 'Asia/Kolkata' });
const A = `/api/projects/${p.id}`; const token = p.api_token;
// Waits until stored events stop changing for 3 s (the ingest queue has drained).
const settle = async (min = 1) => { let last = -1, same = 0; for (let i = 0; i < 60; i++) { const s = await call(`${A}/stats`); if (s.events >= min && s.events === last) { if (++same >= 3) return s; } else same = 0; last = s.events; await sleep(1000); } };
const send = async (events, path = '/batch/') => {
  for (let i = 0; i < events.length; i += 200) {
    const post = () => fetch(site + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: token, batch: events.slice(i, i + 200) }) });
    const r = await post().catch(async () => { await sleep(500); return post(); });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
};
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); const pick = a => a[Math.floor(rnd() * a.length)];
const DAY = 86400_000; const now = Date.now(); const iso = t => new Date(t).toISOString(); const uuid = () => crypto.randomUUID();

// ---- 1. traffic, insights, dashboard, flags (0.1-0.3) ----
if (fresh && !flags.has('--no-traffic')) {
  execFileSync('node', ['scripts/seed-demo.mjs', site, token, '400'], { stdio: 'inherit' });
  await settle(1);
  const ev = (event, extra = {}) => ({ kind: 'EventsNode', event, ...extra }); const r30 = { date_from: '-30d' };
  const mk = (name, query) => call(`${A}/insights`, 'POST', { name, query });
  const ins = [
    await mk('Daily visitors', { kind: 'TrendsQuery', series: [ev('$pageview', { math: 'dau' }), ev('$pageview', { math: 'total' })], interval: 'day', dateRange: r30, trendsFilter: { display: 'ActionsLineGraph' } }),
    await mk('Revenue', { kind: 'TrendsQuery', series: [ev('purchase', { math: 'sum', math_property: 'amount', custom_name: 'Revenue (USD)' })], interval: 'day', dateRange: r30, trendsFilter: { display: 'BoldNumber' }, compareFilter: { compare: true } }),
    await mk('Signup to purchase', { kind: 'FunnelsQuery', series: [ev('$pageview'), ev('signed_up'), ev('purchase')], funnelsFilter: { funnelWindowInterval: 14, funnelWindowIntervalUnit: 'day' }, dateRange: r30 }),
    await mk('Visitors by browser', { kind: 'TrendsQuery', series: [ev('$pageview', { math: 'dau' })], interval: 'day', dateRange: r30, breakdownFilter: { breakdown: '$browser', breakdown_type: 'event' }, trendsFilter: { display: 'ActionsBarValue' } }),
    await mk('Weekly retention', { kind: 'RetentionQuery', retentionFilter: { targetEntity: { id: '$pageview', type: 'events' }, returningEntity: { id: '$pageview', type: 'events' }, period: 'Week', totalIntervals: 6 } }),
  ];
  const d = await call(`${A}/dashboards`, 'POST', { name: 'Store overview', pinned: true });
  for (const i of ins) await call(`${A}/dashboards/${d.id}/tiles`, 'POST', { insight_id: i.id });
  await call(`${A}/feature_flags`, 'POST', { key: 'new-checkout', name: 'New checkout flow', filters: { groups: [{ properties: [{ key: 'plan', value: ['pro'], operator: 'exact', type: 'person' }], rollout_percentage: 100 }, { properties: [], rollout_percentage: 20 }], multivariate: { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] }, payloads: { test: '{"button":"green"}' } } });
  await call(`${A}/feature_flags`, 'POST', { key: 'holiday-banner', name: 'Holiday banner', filters: { groups: [{ properties: [], rollout_percentage: 100 }] } });
  if (!flags.has('--no-browser')) {
    try { execFileSync('node', ['scripts/demo-02.mjs', site, email, password, String(p.id)], { stdio: 'inherit', env: process.env }); }
    catch (e) { log('session replay / experiment / survey step skipped:', String(e.message ?? e).slice(0, 200)); }
  }
}

// ---- 2. error tracking (0.5-0.6) ----
await call(A, 'PATCH', { error_tracking: true });
const issuesBefore = await call(`${A}/error_issues?status=`);
if (!issuesBefore.results.length) {
  const F = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/v05-errors.json', import.meta.url), 'utf8'));
  // Rules first, so new exceptions use them.
  await call(`${A}/error_grouping_rules`, 'POST', { field: 'value', match: 'contains', pattern: 'payment declined', key: 'payment-declined', description: 'Every decline reason is one issue' });
  await call(`${A}/error_suppression_rules`, 'POST', { type: 'OR', values: [{ key: '$exception_types', operator: 'exact', value: ['ResizeObserver loop completed with undelivered notifications'] }], description: 'Browser noise' });
  const js = [];
  const releases = [['1.4.0', 18], ['1.4.1', 9], ['1.5.0', 26]];
  for (const [rel, n] of releases) for (let i = 0; i < n; i++) {
    const e = pick(F.posthog_js_exceptions); const t = now - Math.floor(rnd() * 14 * DAY) - 60_000;
    js.push({ ...e, uuid: uuid(), timestamp: iso(t), properties: { ...e.properties, $time: undefined, $app_version: rel, distinct_id: `shopper-${Math.floor(rnd() * 60)}`, $session_id: undefined } });
  }
  const pyFrames = (fn, line, file = 'shop/checkout.py') => [
    { platform: 'python', filename: 'shop/views.py', abs_path: '/srv/shop/views.py', function: 'post', module: 'shop.views', lineno: 57, in_app: true, pre_context: ['    def post(self, request):', '        cart = Cart.load(request.session)'], context_line: '        order = place_order(cart, request.user)', post_context: ['        return redirect(order.url)'] },
    { platform: 'python', filename: file, abs_path: `/srv/${file}`, function: fn, module: file.replace(/\//g, '.').replace(/\.py$/, ''), lineno: line, in_app: true, pre_context: ['def place_order(cart, user):', '    if cart.total <= 0:'], context_line: '        raise ValueError(f"cart total must be positive, got {cart.total}")', post_context: ['    return Order.create(cart, user)'] }];
  const server = [];
  for (let i = 0; i < 14; i++) server.push({ event: '$exception', distinct_id: `shopper-${i}`, uuid: uuid(), timestamp: iso(now - Math.floor(rnd() * 10 * DAY)), properties: { $lib: 'posthog-python', $app_version: '2026.11.3', $exception_list: [{ type: 'ValueError', value: `cart total must be positive, got -${i + 1}.00`, mechanism: { type: 'generic', handled: false }, stacktrace: { type: 'raw', frames: pyFrames('place_order', 112) } }] } });
  // Two ConnectionError groupings that are really one problem (merged below).
  for (const [k, file] of [[6, 'shop/payments/client.py'], [5, 'shop/inventory/client.py']]) for (let i = 0; i < k; i++) server.push({ event: '$exception', distinct_id: `worker-${i}`, uuid: uuid(), timestamp: iso(now - Math.floor(rnd() * 7 * DAY)), properties: { $lib: 'posthog-python', $exception_list: [{ type: 'ConnectionError', value: 'HTTPSConnectionPool(host=api.internal, port=443): Max retries exceeded', mechanism: { type: 'generic', handled: true }, stacktrace: { type: 'raw', frames: [{ platform: 'python', filename: file, function: 'request', module: file.replace(/\//g, '.'), lineno: 40, in_app: true, context_line: '        return self.session.post(url, json=body, timeout=5)' }] } }] } });
  for (let i = 0; i < 11; i++) server.push({ event: '$exception', distinct_id: `user-${i}`, uuid: uuid(), timestamp: iso(now - Math.floor(rnd() * 12 * DAY)), properties: { $lib: 'posthog-go', $app_version: 'v0.9.' + (i % 3), $exception_list: [{ type: '*billing.DeclineError', value: `payment declined: ${pick(['card_expired', 'insufficient_funds', 'do_not_honor'])}`, mechanism: { type: 'generic', handled: true }, stacktrace: { type: 'raw', frames: [{ platform: 'go', filename: 'cmd/api/main.go', function: 'main.handleCharge', module: 'main', lineno: 88, in_app: true }, { platform: 'go', filename: 'billing/charge.go', function: 'billing.Charge', module: 'acme.dev/billing', lineno: 57 + (i % 3), in_app: true }] } }] } });
  for (let i = 0; i < 4; i++) server.push({ event: '$exception', distinct_id: `edge-${i}`, uuid: uuid(), timestamp: iso(now - Math.floor(rnd() * 5 * DAY)), properties: { $lib: 'posthog-rs', $release: 'img-proxy@0.3.1', $exception_list: [{ type: 'std::io::Error', value: 'connection refused (os error 111)', mechanism: { type: 'generic', handled: true }, stacktrace: { type: 'raw', frames: [{ platform: 'rust', filename: 'src/main.rs', function: 'img_proxy::main', lineno: 31, in_app: true }, { platform: 'rust', filename: 'src/fetch.rs', function: 'img_proxy::fetch::origin', lineno: 74, colno: 18, in_app: true }] } }] } });
  // Suppressed by the rule above (counted on the Usage page, never an issue).
  for (let i = 0; i < 3; i++) server.push({ event: '$exception', distinct_id: `shopper-${i}`, uuid: uuid(), properties: { $lib: 'web', $exception_list: [{ type: 'ResizeObserver loop completed with undelivered notifications', value: '', mechanism: { handled: false } }] } });
  await send([...js, ...server]);
  for (let i = 0; i < 30; i++) { const l = await call(`${A}/error_issues?status=`); if (l.results.length >= 7) break; await sleep(1000); }
  // Source maps per release, uploaded after the fact: retroactive symbolication.
  const MIN_URL = 'http://172.17.0.1:8797/app.min.js';
  for (const rel of ['1.4.1', '1.5.0']) {
    const r = await call(`${A}/symbol_sets?url=${encodeURIComponent(MIN_URL)}&release=${rel}`, 'PUT', F.app_min_js_map);
    log(`source map ${rel}: re-symbolicated ${r.resymbolicated?.symbolicated ?? 0}`);
  }
  const l = (await call(`${A}/error_issues?status=`)).results;
  const conn = l.filter(i => i.type === 'ConnectionError');
  if (conn.length === 2) await call(`${A}/error_issues/${conn[0].id}/merge`, 'POST', { ids: [conn[1].id] });
  const py = l.find(i => i.type === 'ValueError'); if (py) await call(`${A}/error_issues/${py.id}`, 'PATCH', { assignee: email });
  const rs = l.find(i => i.type === 'std::io::Error'); if (rs) await call(`${A}/error_issues/${rs.id}`, 'PATCH', { status: 'resolved' });
}

// ---- 3. LLM analytics (0.6) ----
const llm = await call(`${A}/llm/overview?date_from=-30d`);
if (!llm.totals.generations) {
  const MODELS = [['openai', 'gpt-4o-mini', 0.9, 0.35], ['openai', 'gpt-4.1', 2.1, 0.15], ['anthropic', 'claude-sonnet-4-5', 2.6, 0.2], ['anthropic', 'claude-haiku-4-5', 1.1, 0.12], ['google', 'gemini-2.5-flash', 0.8, 0.1], ['xai', 'grok-4-fast', 0.7, 0.08]];
  const pickModel = () => { let x = rnd(); for (const m of MODELS) { if ((x -= m[3]) <= 0) return m; } return MODELS[0]; };
  const QS = ['Where is my order #4471?', 'Can I return opened headphones?', 'Do you ship to Pune?', 'Change my delivery address', 'Is the blue kettle back in stock?', 'Apply my SAVE10 coupon'];
  const evs = [];
  for (let i = 0; i < 90; i++) {
    const trace = uuid(); const did = `shopper-${Math.floor(rnd() * 60)}`; const t0 = now - Math.floor(rnd() * 14 * DAY) - 120_000; const q = pick(QS);
    const kind = rnd() < 0.7 ? 'support-bot' : rnd() < 0.5 ? 'product-search' : 'review-summarizer';
    const [provider, model, lat] = pickModel(); const err = rnd() < 0.06;
    const retr = uuid(); const embLat = 0.08 + rnd() * 0.1; const genLat = lat * (0.6 + rnd() * 0.9);
    const inTok = 400 + Math.floor(rnd() * 2400); const outTok = 60 + Math.floor(rnd() * 400); const cached = provider === 'anthropic' && rnd() < 0.5 ? Math.floor(inTok * 0.6) : 0;
    const base = { $ai_trace_id: trace, $session_id: undefined, $lib: 'posthog-node', $ai_lib: '@posthog/ai' };
    evs.push({ event: '$ai_span', distinct_id: did, uuid: uuid(), timestamp: iso(t0 + embLat * 1000 + 20), properties: { ...base, $ai_span_id: retr, $ai_parent_id: trace, $ai_span_name: 'retrieve-context', $ai_latency: embLat + 0.02, $ai_input_state: { query: q }, $ai_output_state: { documents: 3 } } });
    evs.push({ event: '$ai_embedding', distinct_id: did, uuid: uuid(), timestamp: iso(t0 + embLat * 1000), properties: { ...base, $ai_span_id: uuid(), $ai_parent_id: retr, $ai_model: 'text-embedding-3-small', $ai_provider: 'openai', $ai_input_tokens: 12 + Math.floor(rnd() * 20), $ai_latency: embLat, $ai_http_status: 200 } });
    const genEnd = t0 + (embLat + 0.05 + genLat) * 1000;
    evs.push({ event: '$ai_generation', distinct_id: did, uuid: uuid(), timestamp: iso(genEnd), properties: { ...base, $ai_span_id: uuid(), $ai_parent_id: trace, $ai_span_name: 'answer', $ai_model: model, $ai_provider: provider,
      $ai_input_tokens: inTok, $ai_output_tokens: err ? 0 : outTok, $ai_cache_read_input_tokens: cached, $ai_latency: genLat, $ai_http_status: err ? pick([429, 529, 500]) : 200, $ai_is_error: err, ...(err ? { $ai_error: pick(['rate_limit_exceeded', 'overloaded_error', 'upstream timeout']) } : {}),
      $ai_temperature: 0.2, $ai_stream: true,
      $ai_input: [{ role: 'system', content: 'You are Acme Store\'s support assistant. Answer briefly using the context.' }, { role: 'user', content: q }],
      $ai_output_choices: err ? [] : [{ role: 'assistant', content: pick(['Your order shipped yesterday and arrives Friday.', 'Yes, within 30 days if you have the receipt.', 'We ship to Pune in 2-4 days.', 'Done: your address is updated.', 'It is back in stock in blue and black.']) }] } });
    if (kind === 'support-bot' && rnd() < 0.4) evs.push({ event: '$ai_generation', distinct_id: did, uuid: uuid(), timestamp: iso(genEnd + 700), properties: { ...base, $ai_span_id: uuid(), $ai_parent_id: trace, $ai_span_name: 'moderate', $ai_model: 'gpt-4o-mini', $ai_provider: 'openai', $ai_input_tokens: 180, $ai_output_tokens: 4, $ai_latency: 0.4, $ai_http_status: 200, $ai_input: [{ role: 'user', content: 'Classify: ' + q }], $ai_output_choices: [{ role: 'assistant', content: 'safe' }] } });
    evs.push({ event: '$ai_trace', distinct_id: did, uuid: uuid(), timestamp: iso(genEnd + 800), properties: { ...base, $ai_span_name: kind, $ai_latency: (genEnd + 800 - t0) / 1000, $ai_input_state: { question: q }, $ai_output_state: err ? { error: true } : { answered: true }, ...(err ? { $ai_is_error: true, $ai_error: 'generation failed' } : {}) } });
  }
  await send(evs, '/i/v0/ai/batch/');
  // Wait until the queue has stored them (the cap step below must not race these events).
  const want = evs.filter(e => e.event === '$ai_generation').length;
  for (let i = 0; i < 40; i++) { const o = await call(`${A}/llm/overview?date_from=-30d`); if (o.totals.generations >= want) break; await sleep(1000); }
}

// ---- 4. usage: drop some events past a cap, then restore the limits ----
const proj = (await call('/api/projects')).find(x => x.id === p.id);
if (!(await call(`${A}/usage`)).dropped_past_cap?.events) {
  await settle(1);
  const keep = proj.limits; const used = (await call(`${A}/usage`)).caps.events.used;
  await call(A, 'PATCH', { limits: { ...(keep ?? {}), events_monthly: used, over_cap: 'drop', alert_emails: keep?.alert_emails ?? [] } });
  const burst = n => Array.from({ length: n }, (_, i) => ({ event: '$pageview', distinct_id: `late-${i}`, uuid: uuid(), properties: { $current_url: 'https://acme.test/sale' } }));
  await send(burst(40));
  await sleep(11_000); // past the 10 s project cache: the edge now answers quota_limited and counts the drop itself
  await send(burst(25)); await sleep(2500); await send(burst(5));
  await sleep(2500);
  await call(A, 'PATCH', { limits: keep ?? null });
}

await call(A, 'PATCH', { public_demo: true });
const u = await call(`${A}/usage`); const o = await call(`${A}/llm/overview?date_from=-30d`); const e = await call(`${A}/error_issues?status=`);
console.log(JSON.stringify({ project: p.id, public_demo: true, issues: e.results.length, llm_generations: o.totals.generations, llm_traces: o.totals.traces, dropped_past_cap: u.dropped_past_cap }));
