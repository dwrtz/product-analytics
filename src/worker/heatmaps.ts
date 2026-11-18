// Heatmaps and scroll depth (design.md "Heatmaps"), merged in the head from every shard in the date range.
import { QueryError, HeatmapSpec } from './eventsql';
import { resolveRange } from '../shared/dates';
type Shard = { heatmap(s: HeatmapSpec): Promise<unknown[][]>; scroll(s: { from: number; to: number; pathname?: string | null }): Promise<unknown[][]> };
const TYPES = new Set(['click', 'rageclick', 'mousemove', 'deadclick', 'scrolldepth']);

function range(q: any) {
  const now = Date.now();
  const r = resolveRange(q.date_from ?? '-7d', q.date_to ?? null, 'UTC', now, null);
  return { from: r.from, to: r.to + 1 };
}
/** PostHog-style heatmap: `type`, `date_from`, `date_to`, `url_exact` or `url_pattern` (`*` wildcard), viewport width bounds. */
export async function heatmapQuery(shards: (from: number, to: number) => Promise<Shard[]>, q: any) {
  const type = String(q.type ?? 'click'); if (!TYPES.has(type) || type === 'scrolldepth') throw new QueryError('type must be click, rageclick, mousemove or deadclick');
  const { from, to } = range(q);
  const spec: HeatmapSpec = { from, to, type, urlExact: q.url_exact ? String(q.url_exact) : null,
    urlLike: q.url_pattern ? String(q.url_pattern).replace(/[%_]/g, m => '\\' + m).replace(/\*/g, '%') : null,
    vwMin: q.viewport_width_min != null && q.viewport_width_min !== '' ? Number(q.viewport_width_min) : null, vwMax: q.viewport_width_max != null && q.viewport_width_max !== '' ? Number(q.viewport_width_max) : null };
  if (spec.urlLike && !spec.urlLike.includes('\\')) { /* LIKE without ESCAPE treats \ literally; patterns rarely contain % or _ */ }
  const list = await shards(from, to - 1);
  const cells = new Map<string, { x: number; y: number; fixed: boolean; count: number; uniq: number }>();
  for (const rows of await Promise.all(list.map(s => s.heatmap(spec)))) for (const r of rows) {
    const k = `${r[0]}|${r[1]}|${r[2]}`; const c = cells.get(k) ?? { x: Number(r[0]) / 100, y: Number(r[1]), fixed: !!Number(r[2]), count: 0, uniq: 0 };
    c.count += Number(r[3]); c.uniq += Number(r[4]); cells.set(k, c);
  }
  const agg = q.aggregation === 'unique_visitors' ? 'unique_visitors' : 'total_count';
  return { results: [...cells.values()].map(c => ({ pointer_relative_x: c.x, pointer_target_fixed: c.fixed, client_y: c.y, count: agg === 'unique_visitors' ? c.uniq : c.count })),
    type, aggregation: agg, date_from: new Date(from).toISOString(), date_to: new Date(to - 1).toISOString() };
}
export async function heatmapUrls(shards: (from: number, to: number) => Promise<Shard[]>, q: any) {
  const { from, to } = range(q);
  const tally = new Map<string, number>();
  for (const rows of await Promise.all((await shards(from, to - 1)).map(s => s.heatmap({ from, to, urls: true })))) for (const r of rows) tally.set(String(r[0]), (tally.get(String(r[0])) ?? 0) + Number(r[1]));
  return { results: [...tally].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([url, count]) => ({ url, count })) };
}
/** Share of page views that scrolled at least each 5% step of the page (from `$prev_pageview_max_scroll_percentage`). */
export async function scrollDepthQuery(shards: (from: number, to: number) => Promise<Shard[]>, q: any) {
  const { from, to } = range(q);
  let pathname: string | null = q.pathname ? String(q.pathname) : null;
  if (!pathname && q.url_exact) { try { pathname = new URL(String(q.url_exact)).pathname; } catch { throw new QueryError('url_exact must be a URL'); } }
  const buckets = new Array(21).fill(0);
  for (const rows of await Promise.all((await shards(from, to - 1)).map(s => s.scroll({ from, to, pathname })))) for (const r of rows) buckets[Number(r[0])] += Number(r[1]);
  const total = buckets.reduce((a, b) => a + b, 0);
  let atLeast = total; const results = [];
  for (let i = 0; i <= 20; i++) { results.push({ percentage: i * 5, count: atLeast, share: total ? atLeast / total : 0 }); atLeast -= buckets[i]; }
  return { pathname, pageviews: total, results, date_from: new Date(from).toISOString(), date_to: new Date(to - 1).toISOString() };
}
