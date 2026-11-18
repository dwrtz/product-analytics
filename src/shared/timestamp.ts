// Event timestamp rules (protocol.md "Timestamps"). Pure; unit-tested against test-vectors.json.
export type TimestampSource = 'offset' | 'sent_at_skew' | 'timestamp_raw' | 'now_fallback';
const FUTURE_CUTOFF_MS = 23 * 3600 * 1000;
const MIN_DATE = Date.UTC(-262143, 0, 1), MAX_DATE = Date.UTC(262142, 11, 31, 23, 59, 59, 999);

/** Parses an ISO 8601 / RFC 3339 date. A trailing "+HH" or "-HH" zone gets ":00". Returns ms or null. */
export function parseDate(s: unknown): number | null {
  if (typeof s !== 'string' || !s) return null;
  let v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?[+-]\d{2}$/.test(v)) v += ':00';
  // Trim sub-millisecond digits, which Date.parse rejects in some engines.
  v = v.replace(/(\.\d{3})\d+/, '$1');
  // A date-time with no zone is UTC.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v = v.replace(' ', 'T') + 'Z';
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function parseEventTimestamp(
  timestamp: unknown, offset: unknown, sentAt: number | null, ignoreSentAt: boolean, now: number,
): { ts: number; source: TimestampSource } {
  let ts = now; let source: TimestampSource = 'now_fallback';
  const sa = ignoreSentAt ? null : sentAt;
  const parsed = parseDate(timestamp);
  if (parsed !== null) {
    if (sa !== null) { ts = parsed - (sa - now); source = 'sent_at_skew'; }
    else { ts = parsed; source = 'timestamp_raw'; }
  }
  const off = typeof offset === 'number' ? offset : typeof offset === 'string' && /^-?\d+$/.test(offset) ? Number(offset) : null;
  // An offset that would put the event outside the representable date range is ignored, as PostHog's chrono-based code does.
  if (off !== null && Number.isFinite(off)) { const t = now - Math.trunc(off); if (t >= MIN_DATE && t <= MAX_DATE) { ts = t; source = 'offset'; } }
  if (ts - now > FUTURE_CUTOFF_MS) ts = now;
  const year = new Date(ts).getUTCFullYear();
  if (!Number.isFinite(ts) || year < 0 || year > 9999) ts = 0;
  return { ts, source };
}
