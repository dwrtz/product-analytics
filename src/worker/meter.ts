// Edge request counters (design.md "Usage limits", "Cost estimate"): SDK flag and remote-config requests, owner API
// requests and what a spending cap dropped at the edge. Counts gather per isolate and per project and are flushed to
// the project store at most every FLUSH_MS (or every FLUSH_AT counts) in ctx.waitUntil, so counting never adds latency
// to the request and a failed flush never fails it. Counts still pending when an isolate is evicted are lost; the
// numbers are an estimate input, not billing.
import { Env, storeFor } from './env';
import { dayKey } from './usage';

export type MeterKind = 'flags' | 'config' | 'api' | 'edge_dropped_requests' | 'edge_dropped_events' | 'edge_dropped_replay';
export type MeterCounts = Partial<Record<MeterKind, number>>;
export const FLUSH_MS = 2000;
export const FLUSH_AT = 200;
type Pending = { day: string; counts: MeterCounts; n: number; last: number };
const pending = new Map<number, Pending>();

/** Adds `n` to a counter for project `pid`; flushes in the background when due. Safe to call without a ctx (no flush). */
export function meter(env: Env, ctx: ExecutionContext | undefined, pid: number, kind: MeterKind, n = 1, now = Date.now()) {
  if (!pid || !(n > 0)) return;
  const day = dayKey(now);
  let p = pending.get(pid);
  if (p && p.day !== day) { flush(env, ctx, pid, p); p = undefined; }
  if (!p) { p = { day, counts: {}, n: 0, last: pending.get(pid)?.last ?? 0 }; pending.set(pid, p); }
  p.counts[kind] = (p.counts[kind] ?? 0) + n; p.n += n;
  if (ctx && (now - p.last >= FLUSH_MS || p.n >= FLUSH_AT)) { flush(env, ctx, pid, p); pending.set(pid, { day, counts: {}, n: 0, last: now }); }
}
function flush(env: Env, ctx: ExecutionContext | undefined, pid: number, p: Pending) {
  if (!p.n || !ctx) return;
  const counts = p.counts; const day = p.day;
  ctx.waitUntil(storeFor(env, pid).recordEdgeUsage(day, counts).catch(e => console.error('meter', pid, e instanceof Error ? e.message : String(e))));
}
/** Test hook: pending counts for a project. */
export const pendingFor = (pid: number) => pending.get(pid)?.counts ?? {};
