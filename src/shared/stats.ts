// Bayesian experiment statistics (design.md "Experiments"). Conjugate posteriors per variant, compared by seeded Monte
// Carlo so results are reproducible: Beta-Binomial for conversion (funnel) metrics, Gamma-Poisson for count metrics and a
// Normal approximation for continuous (sum / average property) metrics.

/** mulberry32: small, fast, seedable PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function normal(r: () => number) {
  let u = 0; while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
/** Marsaglia and Tsang (2000); shape < 1 boosted with U^(1/shape). */
export function gamma(r: () => number, shape: number): number {
  if (shape < 1) return gamma(r, shape + 1) * Math.pow(r() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0, v = 0;
    do { x = normal(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export const beta = (r: () => number, a: number, b: number) => { const x = gamma(r, a); return x / (x + gamma(r, b)); };

export type Posterior = { kind: 'beta'; a: number; b: number } | { kind: 'gamma'; shape: number; rate: number } | { kind: 'normal'; mean: number; sd: number };
export function draw(r: () => number, p: Posterior): number {
  if (p.kind === 'beta') return beta(r, p.a, p.b);
  if (p.kind === 'gamma') return gamma(r, p.shape) / p.rate;
  return p.mean + p.sd * normal(r);
}
export const PRIOR = { beta: [1, 1] as const, gamma: [1, 1] as const };

/** Conversion: successes of n exposures, Beta(1 + s, 1 + n - s). */
export const binomialPosterior = (s: number, n: number): Posterior => ({ kind: 'beta', a: PRIOR.beta[0] + s, b: PRIOR.beta[1] + n - s });
/** Count per exposure: total events over n exposures, Gamma(1 + count, 1 + n). */
export const poissonPosterior = (count: number, n: number): Posterior => ({ kind: 'gamma', shape: PRIOR.gamma[0] + count, rate: PRIOR.gamma[1] + n });
/** Mean of per-person values: Normal(mean, sd / sqrt(n)), the large-sample posterior under a flat prior. */
export function normalPosterior(values: number[]): Posterior {
  const n = values.length; if (!n) return { kind: 'normal', mean: 0, sd: 1e9 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : mean * mean || 1;
  return { kind: 'normal', mean, sd: Math.sqrt(v / n) || 1e-9 };
}
export const posteriorMean = (p: Posterior) => p.kind === 'beta' ? p.a / (p.a + p.b) : p.kind === 'gamma' ? p.shape / p.rate : p.mean;

export type Comparison = { probability_to_be_best: number[]; credible_intervals: [number, number][]; uplift: (number | null)[]; uplift_intervals: ([number, number] | null)[]; expected_loss: number[] };
/** P(best), 95% credible intervals, and uplift against variant 0 (control), from `draws` joint samples. */
export function compare(ps: Posterior[], seed = 42, draws = 20000): Comparison {
  const r = rng(seed); const k = ps.length;
  const samples = ps.map(() => new Float64Array(draws));
  const best = new Array(k).fill(0); const loss = new Array(k).fill(0);
  for (let i = 0; i < draws; i++) {
    let bi = 0, bv = -Infinity;
    for (let j = 0; j < k; j++) { const x = draw(r, ps[j]); samples[j][i] = x; if (x > bv) { bv = x; bi = j; } }
    best[bi]++;
    for (let j = 0; j < k; j++) loss[j] += bv - samples[j][i];
  }
  const q = (a: Float64Array, p: number) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
  const ci = samples.map(s => { const c = Float64Array.from(s).sort(); return [q(c, 0.025), q(c, 0.975)] as [number, number]; });
  const uplift = ps.map((_, j) => j === 0 ? null : (posteriorMean(ps[j]) - posteriorMean(ps[0])) / (Math.abs(posteriorMean(ps[0])) || 1e-12));
  const upliftCi = ps.map((_, j) => {
    if (j === 0) return null;
    const d = new Float64Array(draws); for (let i = 0; i < draws; i++) d[i] = (samples[j][i] - samples[0][i]) / (Math.abs(samples[0][i]) || 1e-12);
    d.sort(); return [q(d, 0.025), q(d, 0.975)] as [number, number];
  });
  return { probability_to_be_best: best.map(b => b / draws), credible_intervals: ci, uplift, uplift_intervals: upliftCi, expected_loss: loss.map(l => l / draws) };
}

/** Exact P(B > A) for two Beta posteriors with integer B.a (Evan Miller's formula); used to check the sampler. */
export function probBBeatsA(aA: number, bA: number, aB: number, bB: number): number {
  const lbeta = (x: number, y: number) => lgamma(x) + lgamma(y) - lgamma(x + y);
  let total = 0;
  for (let i = 0; i < aB; i++) total += Math.exp(lbeta(aA + i, bA + bB) - Math.log(bB + i) - lbeta(1 + i, bB) - lbeta(aA, bA));
  return total;
}
/** Lanczos approximation of ln Γ(x). */
export function lgamma(x: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
