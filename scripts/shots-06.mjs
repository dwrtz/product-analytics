// 0.6 screenshots of the demo project built by scripts/demo-setup.mjs: LLM analytics overview and a trace, error
// tracking (releases, assignee, merged and multi-language issues), usage (dropped past cap, list-price cost) and the
// read-only public demo as a signed-out visitor sees it.
// Usage: PA_DEMO_PASSWORD=... node scripts/shots-06.mjs <site> <email> <outDir>
import fs from 'node:fs';
import { chromium } from 'playwright';
const [site0, email, out] = process.argv.slice(2); const password = process.env.PA_DEMO_PASSWORD;
if (!site0 || !email || !out || !password) { console.error('usage: PA_DEMO_PASSWORD=... node scripts/shots-06.mjs <site> <email> <outDir>'); process.exit(2); }
const site = site0.replace(/\/+$/, ''); fs.mkdirSync(out, { recursive: true });
let cookie = '';
const call = async (path, method = 'GET', body) => {
  const r = await fetch(site + path, { method, headers: { origin: site, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`); return data;
};
await call('/api/login', 'POST', { email, password });
const p = (await call('/api/projects')).find(x => x.name === 'Acme Store'); if (!p) throw new Error('run scripts/demo-setup.mjs first');
const A = `/api/projects/${p.id}`;
const traces = (await call(`${A}/llm/traces?date_from=-30d&search=support-bot`)).results;
const trace = traces.find(t => t.spans >= 4 && t.status === 'ok') ?? traces[0];
const b = await chromium.launch();
const desk = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const lp = await desk.newPage(); await lp.goto(site + '/login'); await lp.fill('input[type=email]', email); await lp.fill('input[type=password]', password); await lp.click('button[type=submit]'); await lp.waitForURL(/project/); await lp.close();
const shoot = async (ctx, path, file, full = false, after) => {
  const pg = await ctx.newPage(); await pg.goto(site + path); await pg.waitForLoadState('networkidle'); await pg.waitForTimeout(1200);
  if (after) await after(pg);
  await pg.screenshot({ path: `${out}/${file}`, fullPage: full }); await pg.close(); console.log('shot', file);
};
await shoot(desk, `/project/${p.id}/llm?date_from=-14d`, 'llm-analytics.png', true);
await shoot(desk, `/project/${p.id}/llm/traces/${encodeURIComponent(trace.id)}?ts=${trace.timestamp}`, 'llm-trace.png', true);
await shoot(desk, `/project/${p.id}/errors?status=all`, 'error-tracking.png', true);
await shoot(desk, `/project/${p.id}/usage?days=30`, 'usage.png', false);
const visitor = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
await shoot(visitor, `/project/${p.id}/errors`, 'public-demo.png', false);
await b.close();
console.log(JSON.stringify({ project: p.id, trace: trace.id }));
