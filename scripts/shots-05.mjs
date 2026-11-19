// 0.5 demo data and screenshots: real posthog-js visitors on a store page whose minified bundle throws (exception
// autocapture from remote config, manual captureException), source maps uploaded with scripts/upload-sourcemaps.mjs,
// usage limits set; then screenshots of the usage page, the issues list and an issue with its symbolicated stack trace.
// Usage: node scripts/shots-05.mjs <site> <email> <password> <outDir>   (signs up the account if the instance is empty)
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
const [site, email, password, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
let cookie = '';
const call = async (path, method = 'GET', body) => {
  const r = await fetch(site + path, { method, headers: { origin: site, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`); return data;
};
try { await call('/api/login', 'POST', { email, password }); } catch { await call('/api/signup', 'POST', { email, password, name: 'Demo' }); }
const proj = (await call('/api/projects')).find(p => p.name === 'Acme Store') ?? await call('/api/projects', 'POST', { name: 'Acme Store', timezone: 'UTC' });
const pid = proj.id; const A = `/api/projects/${pid}`;
const p = await call(A, 'PATCH', { session_recording: true, error_tracking: true, replay_config: { sample_rate: 1, console: true }, limits: { events_monthly: 2000, replay_recordings_monthly: 500, replay_bytes_monthly: 1024 ** 3, autocapture_sample_rate: 1, over_cap: 'drop' } });

// The site's code, bundled and minified with a source map.
const HOST = 'acme-store.test'; const PORT = 8811;
const dir = '/tmp/shots05-site'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir + '/src', { recursive: true });
fs.writeFileSync(dir + '/src/cart.js', `export function lineTotal(item) {
  if (typeof item.price !== 'number') {
    throw new TypeError('Cannot price item ' + item.sku + ': price is ' + typeof item.price);
  }
  return item.price * item.qty;
}
export function cartTotal(cart) {
  return cart.items.reduce((sum, item) => sum + lineTotal(item), 0);
}
`);
fs.writeFileSync(dir + '/src/coupons.js', `import { cartTotal } from './cart.js';
export function applyCoupon(cart, code) {
  const total = cartTotal(cart);
  if (!code.startsWith('ACME')) throw new RangeError('Unknown coupon ' + code);
  return total * 0.9;
}
`);
fs.writeFileSync(dir + '/src/main.js', `import { applyCoupon } from './coupons.js';
import { cartTotal } from './cart.js';
async function loadRecommendations(userId) {
  const res = await fetch('/api/recommendations?user=' + userId);
  if (!res.ok) throw new Error('Recommendations failed with HTTP ' + res.status);
  return res.json();
}
window.shop = {
  checkout() { cartTotal({ items: [{ sku: 'TRAIL-42', price: 89, qty: 1 }, { sku: 'JACKET-7', price: '129', qty: 1 }] }); },
  coupon() { try { applyCoupon({ items: [{ sku: 'PACK-3', price: 59, qty: 1 }] }, 'SUMMER10'); } catch (e) { window.posthog.captureException(e, { coupon: 'SUMMER10' }); } },
  recommend() { loadRecommendations(window.posthog.get_distinct_id()); },
};
`);
fs.mkdirSync(dir + '/assets', { recursive: true });
execFileSync('./node_modules/.bin/esbuild', [dir + '/src/main.js', '--bundle', '--minify', '--sourcemap', '--format=iife', `--outfile=${dir}/assets/shop.min.js`, '--log-level=warning']);
const { key } = await call('/api/personal_api_keys', 'POST', { label: 'source maps (demo)' });
console.log(execFileSync('node', ['scripts/upload-sourcemaps.mjs', '--host', site, '--project', String(pid), '--dir', dir + '/assets', '--url-prefix', `http://${HOST}:${PORT}/assets/`], { env: { ...process.env, PA_PERSONAL_API_KEY: key } }).toString().trim());

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Acme Store</title><style>body{font:16px system-ui;margin:0;background:#f8fafc;color:#0f172a}header{background:#1e293b;color:#fff;padding:14px 24px;font-weight:700}main{padding:24px;display:flex;gap:12px}button{background:#16a34a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px;cursor:pointer}</style>
<script src="${site}/static/array.js"></script><script>posthog.init(${JSON.stringify(p.api_token)}, { api_host: ${JSON.stringify(site)}, person_profiles: 'identified_only', opt_out_useragent_filter: true })</script>
<script src="/assets/shop.min.js"></script></head><body><header>Acme Store</header>
<main><button id="checkout" onclick="shop.checkout()">Checkout</button><button id="coupon" onclick="shop.coupon()">Apply coupon</button><button id="recommend" onclick="shop.recommend()">Recommendations</button></main></body></html>`;
const srv = http.createServer((q, s) => {
  if (q.url.startsWith('/assets/shop.min.js')) { s.writeHead(200, { 'content-type': 'application/javascript' }); return s.end(fs.readFileSync(dir + '/assets/shop.min.js')); }
  if (q.url.startsWith('/api/')) { s.writeHead(503, { 'content-type': 'application/json' }); return s.end('{"error":"busy"}'); }
  s.writeHead(200, { 'content-type': 'text/html' }); s.end(page);
});
await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
const b = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
const people = ['maria', 'chen', 'sam', 'olu', 'ines', 'kai', 'noor', 'tom'];
for (const [i, who] of people.entries()) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 } }); const pg = await ctx.newPage();
  await pg.goto(`http://${HOST}:${PORT}/`); await pg.waitForFunction(() => window.posthog?.__loaded); await pg.waitForTimeout(1500);
  if (i % 2 === 0) await pg.evaluate(w => window.posthog.identify(w + '@example.com', { email: w + '@example.com' }), who);
  for (const id of ['#checkout', i % 3 === 0 ? '#coupon' : '#checkout', i % 2 ? '#recommend' : '#coupon', '#checkout']) { await pg.click(id); await pg.waitForTimeout(600); }
  await pg.waitForTimeout(4000); await ctx.close();
}
srv.close();
await new Promise(r => setTimeout(r, 6000));
const issues = (await call(`${A}/error_issues?order=occurrences`)).results;
console.log('issues', issues.map(i => `${i.type}: ${i.message} (${i.occurrences}, ${i.users} users) ${i.top_frame}`));
const top = issues.find(i => i.type === 'TypeError') ?? issues[0];

const desk = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const lp = await desk.newPage(); await lp.goto(site + '/login'); await lp.fill('input[type=email]', email); await lp.fill('input[type=password]', password); await lp.click('button[type=submit]'); await lp.waitForURL(/project/); await lp.close();
const shoot = async (path, file, full = false) => {
  const pg = await desk.newPage(); await pg.goto(site + path); await pg.waitForLoadState('networkidle'); await pg.waitForTimeout(1200);
  await pg.screenshot({ path: `${out}/${file}`, fullPage: full }); await pg.close(); console.log('shot', file);
};
await shoot(`/project/${pid}/usage?days=7`, 'usage.png', true);
await shoot(`/project/${pid}/errors`, 'error-issues.png');
await shoot(`/project/${pid}/errors/${top.id}`, 'error-issue.png', true);
await shoot(`/project/${pid}/settings#limits`, 'usage-limits.png');
await b.close();
console.log(JSON.stringify({ pid, top: top.id }));
