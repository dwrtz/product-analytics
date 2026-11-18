// Experiment results (design.md "Experiments"): exposure is a person's first `$feature_flag_called` for the experiment's
// flag (variant = `$feature_flag_response`); metrics count only events at or after that exposure, up to the end date.
import { Engine, EventsNode, PropertyFilter, funnelPeople, personFunnel, QueryError } from './query';
import { binomialPosterior, poissonPosterior, normalPosterior, compare, posteriorMean, Posterior } from '../shared/stats';

export type Metric = { kind: 'funnel'; name?: string; series: EventsNode[]; window_days?: number }
  | { kind: 'count'; name?: string; event: EventsNode }
  | { kind: 'continuous'; name?: string; event: EventsNode; math_property: string };
export type Experiment = { id: number; name: string; feature_flag_key: string; start_date: number | null; end_date: number | null; metrics: Metric[]; filters?: PropertyFilter[] };
export const MIN_EXPOSURES = 50, SIGNIFICANCE = 0.95;

export function validateMetric(m: any): Metric {
  if (!m || typeof m !== 'object') throw new QueryError('metric must be an object');
  if (m.kind === 'funnel') { if (!Array.isArray(m.series) || m.series.length < 1 || m.series.length > 10) throw new QueryError('a funnel metric needs 1-10 steps'); return { kind: 'funnel', name: m.name, series: m.series.map((s: any) => ({ event: s?.event ?? null, properties: s?.properties ?? [] })), window_days: Number(m.window_days) || 14 }; }
  if (m.kind === 'count') return { kind: 'count', name: m.name, event: { event: m.event?.event ?? null, properties: m.event?.properties ?? [] } };
  if (m.kind === 'continuous') { if (!m.math_property) throw new QueryError('a continuous metric needs math_property'); return { kind: 'continuous', name: m.name, event: { event: m.event?.event ?? null, properties: m.event?.properties ?? [] }, math_property: String(m.math_property) }; }
  throw new QueryError('metric kind must be funnel, count or continuous');
}

export async function experimentResults(en: Engine, exp: Experiment, variants: string[], now: number) {
  if (!exp.start_date) return { status: 'draft', variants: variants.map(key => ({ key, exposures: 0 })), metrics: [] };
  const from = exp.start_date, to = Math.min(exp.end_date ?? now, now);
  // Exposures: first $feature_flag_called per person; persons seen with two different variants are excluded.
  const exposureNode: EventsNode = { event: '$feature_flag_called', properties: [{ key: '$feature_flag', value: [exp.feature_flag_key], operator: 'exact' }] };
  const { byPerson } = await funnelPeople(en, [exposureNode], exp.filters, from, to, { breakdown: '$feature_flag_response', breakdown_type: 'event' });
  const exposed = new Map<string, { variant: string; ts: number }>();
  let multiple = 0;
  for (const [pk, evs] of byPerson) {
    const vs = new Set(evs.map(e => e.bv).filter(v => variants.includes(v)));
    if (vs.size > 1) { multiple++; continue; }
    const first = evs.find(e => variants.includes(e.bv)); if (first) exposed.set(pk, { variant: first.bv, ts: first.ts });
  }
  const groups = variants.map(key => [...exposed].filter(([, x]) => x.variant === key));
  const exposures = groups.map(g => g.length);
  const metrics = [];
  for (const m of exp.metrics) {
    let posts: Posterior[]; let summary: Record<string, number>[];
    if (m.kind === 'funnel') {
      const n = m.series.length; const win = (m.window_days ?? 14) * 86400_000;
      const { byPerson: ev } = await funnelPeople(en, m.series, exp.filters, from, to, null);
      const conv = groups.map(g => g.filter(([pk, x]) => { const evs = (ev.get(pk) ?? []).filter(e => e.ts >= x.ts); const r = personFunnel(evs, n, win, false, { from: x.ts, to }); return !!r && r.reached === n; }).length);
      posts = conv.map((c, i) => binomialPosterior(c, exposures[i]));
      summary = conv.map((c, i) => ({ conversions: c, conversion_rate: exposures[i] ? c / exposures[i] : 0 }));
    } else {
      const { byPerson: ev } = await funnelPeople(en, [m.event], exp.filters, from, to, null, m.kind === 'continuous' ? m.math_property : null);
      const per = groups.map(g => g.map(([pk, x]) => (ev.get(pk) ?? []).filter(e => e.ts >= x.ts)));
      if (m.kind === 'count') {
        const counts = per.map(p => p.reduce((a, evs) => a + evs.length, 0));
        posts = counts.map((c, i) => poissonPosterior(c, exposures[i]));
        summary = counts.map((c, i) => ({ count: c, mean: exposures[i] ? c / exposures[i] : 0 }));
      } else {
        const vals = per.map(p => p.map(evs => evs.reduce((a, e) => a + (e.v ?? 0), 0)));
        posts = vals.map(v => normalPosterior(v));
        summary = vals.map(v => ({ sum: v.reduce((a, b) => a + b, 0), mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0 }));
      }
    }
    const c = compare(posts, 42 + metrics.length);
    const bestIdx = c.probability_to_be_best.indexOf(Math.max(...c.probability_to_be_best));
    const enough = exposures.every(x => x >= MIN_EXPOSURES);
    const significant = enough && c.probability_to_be_best[bestIdx] >= SIGNIFICANCE;
    metrics.push({
      kind: m.kind, name: m.name ?? metricName(m), significant, winner: significant ? variants[bestIdx] : null,
      reason: !enough ? `Each variant needs at least ${MIN_EXPOSURES} exposures.` : significant ? null : `No variant has a ${SIGNIFICANCE * 100}% chance to be best yet.`,
      variants: variants.map((key, i) => ({ key, exposures: exposures[i], ...summary[i], posterior_mean: posteriorMean(posts[i]), credible_interval: c.credible_intervals[i],
        probability_to_be_best: c.probability_to_be_best[i], uplift: c.uplift[i], uplift_interval: c.uplift_intervals[i], expected_loss: c.expected_loss[i] })),
    });
  }
  return { status: exp.end_date ? 'complete' : 'running', date_from: new Date(from).toISOString(), date_to: new Date(to).toISOString(),
    variants: variants.map((key, i) => ({ key, exposures: exposures[i] })), multiple_variant_persons: multiple, metrics };
}
export const metricName = (m: Metric) => m.kind === 'funnel' ? m.series.map(s => s.event ?? 'All events').join(' → ') : m.kind === 'count' ? `${m.event.event ?? 'All events'} count` : `${m.event.event ?? 'All events'} ${m.math_property}`;
