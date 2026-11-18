// Date ranges and interval buckets in a project time zone (design.md "Queries"). Pure.
export type Interval = 'hour' | 'day' | 'week' | 'month';

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = dtfCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }); dtfCache.set(tz, f); }
  const o: Record<string, string> = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
/** Offset of tz from UTC at instant ms, in ms. */
export function tzOffset(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** UTC ms of a wall-clock time in tz. */
export function fromLocal(y: number, m: number, d: number, h: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}
export function localParts(ms: number, tz: string) { return parts(ms, tz); }

/** Start of the interval containing ms. Weeks start on Sunday. */
export function startOf(ms: number, unit: Interval, tz: string): number {
  const p = parts(ms, tz);
  if (unit === 'hour') return fromLocal(p.y, p.m, p.d, p.h, tz);
  if (unit === 'day') return fromLocal(p.y, p.m, p.d, 0, tz);
  if (unit === 'week') { const d = new Date(Date.UTC(p.y, p.m - 1, p.d - p.wd)); return fromLocal(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, tz); }
  return fromLocal(p.y, p.m, 1, 0, tz);
}
export function addInterval(ms: number, unit: Interval, n: number, tz: string): number {
  if (unit === 'hour') return ms + n * 3600_000;
  const p = parts(ms, tz);
  if (unit === 'day') { const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return fromLocal(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.h, tz); }
  if (unit === 'week') return addInterval(ms, 'day', 7 * n, tz);
  const d = new Date(Date.UTC(p.y, p.m - 1 + n, 1)); return fromLocal(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(p.d, 28), p.h, tz);
}

/**
 * Resolves a date_from/date_to pair. Relative forms: "-7d", "-24h", "-2w", "-3m", "-1y", "dStart" (today),
 * "mStart", "yStart", "all"; or an ISO date / date-time. A bare date in date_to means the end of that day.
 */
export function resolveRange(from: string | null | undefined, to: string | null | undefined, tz: string, now: number, firstEventMs?: number | null): { from: number; to: number } {
  const rel = (s: string, isTo: boolean): number | null => {
    if (s === 'all') return firstEventMs ?? now - 365 * 86400_000;
    if (s === 'dStart') return startOf(now, 'day', tz);
    if (s === 'mStart') return startOf(now, 'month', tz);
    if (s === 'yStart') { const p = parts(now, tz); return fromLocal(p.y, 1, 1, 0, tz); }
    const m = /^-(\d+)([hdwmy])$/.exec(s);
    if (m) {
      const n = +m[1];
      if (m[2] === 'h') return now - n * 3600_000;
      const today = startOf(now, 'day', tz);
      if (m[2] === 'd') return addInterval(today, 'day', -n, tz);
      if (m[2] === 'w') return addInterval(today, 'day', -7 * n, tz);
      if (m[2] === 'm') return addInterval(today, 'month', -n, tz);
      return addInterval(today, 'month', -12 * n, tz);
    }
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (dm) { const t = fromLocal(+dm[1], +dm[2], +dm[3], 0, tz); return isTo ? addInterval(t, 'day', 1, tz) - 1 : t; }
    const t = Date.parse(s); return Number.isFinite(t) ? t : null;
  };
  const f = rel(from || '-7d', false) ?? addInterval(startOf(now, 'day', tz), 'day', -7, tz);
  const t = to ? rel(to, true) ?? now : now;
  return { from: f, to: Math.max(f, t) };
}

/** Interval buckets [start, end) covering the range, aligned to the interval start in tz. */
export function buckets(range: { from: number; to: number }, unit: Interval, tz: string, max = 2000): { start: number; end: number; label: string }[] {
  const out: { start: number; end: number; label: string }[] = [];
  let s = startOf(range.from, unit, tz);
  while (s <= range.to && out.length < max) {
    const e = startOf(addInterval(s, unit, 1, tz) + (unit === 'hour' ? 0 : 3600_000), unit, tz);
    out.push({ start: s, end: e > s ? e : s + 3600_000, label: label(s, unit, tz) });
    s = out[out.length - 1].end;
  }
  return out;
}
export function label(ms: number, unit: Interval, tz: string): string {
  const p = parts(ms, tz); const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (unit === 'hour') return `${date} ${pad(p.h)}:00`;
  if (unit === 'month') return `${p.y}-${pad(p.m)}`;
  return date;
}
