// Builds the demo project used for screenshots: signs in (or signs up), creates "Acme Store", seeds 58 days of traffic,
// and saves insights, a dashboard and two flags. Usage: node scripts/demo-setup.mjs <site> <email> <password>
import { execFileSync } from 'node:child_process';
const [site, email, password] = process.argv.slice(2);
let cookie = '';
const call = async (path, method = 'GET', body) => {
  const r = await fetch(site + path, { method, headers: { origin: site, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({})); if (!r.ok && !(path === '/api/signup' && (r.status === 409 || r.status === 403))) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
};
await call('/api/signup', 'POST', { email, password, name: 'Ada' });
await call('/api/login', 'POST', { email, password });
const p = await call('/api/projects', 'POST', { name: 'Acme Store', timezone: 'Asia/Kolkata' });
execFileSync('node', ['scripts/seed-demo.mjs', site, p.api_token, '400'], { stdio: 'inherit' });
const A = `/api/projects/${p.id}`;
for (let i = 0; i < 30; i++) { const s = await call(`${A}/stats`); if (s.events > 0 && Date.now() - s.last_event_at > 1500) break; await new Promise(r => setTimeout(r, 1000)); }
const ev = (event, extra = {}) => ({ kind: 'EventsNode', event, ...extra });
const mk = (name, query) => call(`${A}/insights`, 'POST', { name, query });
const r30 = { date_from: '-30d' };
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
console.log(JSON.stringify({ project: p.id, dashboard: d.id }));
