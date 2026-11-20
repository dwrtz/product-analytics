// Error tracking (design.md "Error tracking", protocol.md "Exceptions"): posthog-js / posthog-node `$exception` events
// carry `$exception_list` (outer exception first; each with stacktrace.frames, innermost frame LAST). At ingest the
// project store symbolicates minified frames with uploaded source maps, fingerprints the exception and groups it into
// an issue.
import { DecodedMap, originalPosition, contextLines, enclosingName } from '../shared/sourcemap';

export type Frame = {
  filename?: string; abs_path?: string; function?: string; lineno?: number; colno?: number; in_app?: boolean; platform?: string; module?: string;
  pre_context?: string[]; context_line?: string; post_context?: string[];
  resolved?: boolean; minified?: { filename?: string; function?: string; lineno?: number; colno?: number };
};
export type ExceptionEntry = { type?: string; value?: string; mechanism?: Record<string, unknown>; stacktrace?: { type?: string; frames?: Frame[] } };

const obj = (v: unknown): Record<string, any> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;

/** The event's exception list, accepting the older `$exception_type` / `$exception_message` single-exception form. */
export function exceptionList(props: Record<string, unknown>): ExceptionEntry[] {
  const l = props.$exception_list;
  if (Array.isArray(l)) return l.filter(x => obj(x)).slice(0, 20) as ExceptionEntry[];
  if (typeof props.$exception_type === 'string' || typeof props.$exception_message === 'string')
    return [{ type: String(props.$exception_type ?? 'Error'), value: String(props.$exception_message ?? ''), stacktrace: { frames: [] } }];
  return [];
}
const framesOf = (e: ExceptionEntry): Frame[] => Array.isArray(e.stacktrace?.frames) ? e.stacktrace!.frames!.filter(f => obj(f)).slice(-200) : [];

/** Path part of a frame filename or upload URL: no scheme, host, query or fragment. */
export function pathOf(f: string): string {
  let s = f.trim().replace(/[?#].*$/, '');
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(s); if (m) s = m[1] ?? '/';
  return s;
}
/** URL without query or fragment (the symbol set key). */
export const refOf = (u: string) => u.trim().replace(/[?#].*$/, '');
/** Filename normalized for grouping: path only, with build hashes (app.3f9a2c1b.js, chunk-AB12CD34.js) removed. */
export function normalizeFilename(f: string | undefined): string {
  if (!f) return '';
  return pathOf(f).replace(/[.-][0-9a-f]{6,}(?=\.[a-z]+$)/i, m0 => /\d/.test(m0) ? '' : m0).replace(/-[A-Za-z0-9_]{8}(?=\.m?js$)/, m0 => /\d/.test(m0) && /[A-Z]/.test(m0) ? '' : m0);
}
/** Message with numbers, ids and quoted values removed, for grouping exceptions that have no stack. */
export const normalizeMessage = (m: string) => m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/(["'`]).*?\1/g, '<str>').replace(/\b0x[0-9a-f]+\b/gi, '<hex>').replace(/\d+(\.\d+)?/g, '<n>').slice(0, 300);

async function sha(s: string) { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); return [...d].slice(0, 16).map(x => x.toString(16).padStart(2, '0')).join(''); }

// ---------- 0.6: releases, grouping rules, suppression rules ----------
/** Release of an exception event: `$release`, `release`, `$app_version` or `app_version` (first non-empty), max 200 chars. */
export function releaseOf(props: Record<string, unknown>): string | null {
  for (const k of ['$release', 'release', '$app_version', 'app_version']) {
    const v = props[k]; if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim().slice(0, 200);
  }
  return null;
}

/** A per-project grouping rule (design.md "Grouping rules"): the first enabled rule that matches sets the fingerprint. */
export type GroupingRule = { id?: number; field: 'type' | 'value' | 'filename' | 'function'; match: 'contains' | 'exact' | 'regex'; pattern: string; key: string; description?: string; enabled?: boolean };
export class RuleError extends Error {}
const FIELDS = ['type', 'value', 'filename', 'function'] as const;
/** Validates a grouping rule from the owner API. */
export function cleanGroupingRule(b: any): GroupingRule {
  if (!b || typeof b !== 'object') throw new RuleError('rule must be an object');
  if (!FIELDS.includes(b.field)) throw new RuleError('field must be type, value, filename or function');
  if (!['contains', 'exact', 'regex'].includes(b.match)) throw new RuleError('match must be contains, exact or regex');
  const pattern = String(b.pattern ?? ''); if (!pattern || pattern.length > 500) throw new RuleError('pattern is required (at most 500 characters)');
  if (b.match === 'regex') { try { new RegExp(pattern); } catch { throw new RuleError('pattern is not a valid regular expression'); } }
  const key = String(b.key ?? '').trim(); if (!key || key.length > 200) throw new RuleError('key (the issue fingerprint for matches) is required, at most 200 characters');
  return { field: b.field, match: b.match, pattern, key, description: String(b.description ?? '').slice(0, 300), enabled: b.enabled !== false };
}
const testStr = (match: GroupingRule['match'], pattern: string, v: string | undefined | null) => {
  if (v === undefined || v === null) return false;
  if (match === 'exact') return v === pattern;
  if (match === 'contains') return v.toLowerCase().includes(pattern.toLowerCase());
  try { return new RegExp(pattern).test(v); } catch { return false; }
};
/** True when a rule matches the outer exception (type, message) or any of its frames (filename, function). */
export function ruleMatches(r: GroupingRule, list: ExceptionEntry[]): boolean {
  const e = list[0] ?? {};
  if (r.field === 'type') return testStr(r.match, r.pattern, e.type ?? 'Error');
  if (r.field === 'value') return testStr(r.match, r.pattern, e.value ?? '');
  return framesOf(e).some(f => testStr(r.match, r.pattern, r.field === 'filename' ? (f.filename ?? f.abs_path) : f.function));
}

/**
 * Suppression rules (protocol.md "Exceptions"): served to posthog-js in remote config as
 * `errorTracking.suppressionRules` and also applied at ingest (server SDKs do not read remote config). Same shape and
 * operators as posthog-js: a rule is `{ type: 'AND' | 'OR', values: [{ key: '$exception_types' | '$exception_values',
 * operator, value, type: 'error_tracking_issue_property' }] }`.
 */
export type SuppressionValue = { key: '$exception_types' | '$exception_values'; operator: string; value: string | string[]; type: string };
export type SuppressionRule = { type: 'AND' | 'OR'; values: SuppressionValue[] };
export const SUPPRESSION_OPERATORS = ['exact', 'is_not', 'icontains', 'not_icontains', 'regex', 'not_regex'] as const;
export function cleanSuppressionRule(b: any): SuppressionRule {
  if (!b || typeof b !== 'object') throw new RuleError('rule must be an object');
  const type = b.type === 'OR' ? 'OR' : b.type === 'AND' || b.type === undefined ? 'AND' : null; if (!type) throw new RuleError("type must be 'AND' or 'OR'");
  if (!Array.isArray(b.values) || !b.values.length || b.values.length > 10) throw new RuleError('values must list 1-10 conditions');
  const values = b.values.map((v: any): SuppressionValue => {
    if (v?.key !== '$exception_types' && v?.key !== '$exception_values') throw new RuleError('key must be $exception_types or $exception_values');
    if (!SUPPRESSION_OPERATORS.includes(v.operator)) throw new RuleError(`operator must be one of ${SUPPRESSION_OPERATORS.join(', ')}`);
    const vals = (Array.isArray(v.value) ? v.value : [v.value]).map((x: unknown) => String(x ?? '')).filter((x: string) => x.length);
    if (!vals.length || vals.some((x: string) => x.length > 500)) throw new RuleError('value is required (at most 500 characters each)');
    if (v.operator === 'regex' || v.operator === 'not_regex') for (const x of vals) { try { new RegExp(x); } catch { throw new RuleError(`not a valid regular expression: ${x}`); } }
    return { key: v.key, operator: v.operator, value: Array.isArray(v.value) ? vals : vals[0], type: 'error_tracking_issue_property' };
  });
  return { type, values };
}
const re = (s: string, p: string) => { try { return new RegExp(p).test(s); } catch { return false; } };
const lc = (s: string) => s.toLowerCase();
/** posthog-js's operator table: `want` are the rule values, `have` the exception types or values. */
const OPS: Record<string, (want: string[], have: string[]) => boolean> = {
  exact: (w, h) => h.some(x => w.some(y => x === y)),
  is_not: (w, h) => h.every(x => w.every(y => x !== y)),
  regex: (w, h) => h.some(x => w.some(y => re(x, y))),
  not_regex: (w, h) => h.every(x => w.every(y => !re(x, y))),
  icontains: (w, h) => h.map(lc).some(x => w.map(lc).some(y => x.includes(y))),
  not_icontains: (w, h) => h.map(lc).every(x => w.map(lc).every(y => !x.includes(y))),
};
/** True when any rule suppresses this exception list (evaluated the way posthog-js does before sending). */
export function suppressed(rules: SuppressionRule[], list: ExceptionEntry[]): boolean {
  if (!rules.length || !list.length) return false;
  const have = { $exception_types: list.map(e => e.type).filter((x): x is string => typeof x === 'string' && x.length > 0), $exception_values: list.map(e => e.value).filter((x): x is string => typeof x === 'string' && x.length > 0) };
  return rules.some(r => {
    const res = r.values.map(v => { const op = OPS[v.operator]; const h = have[v.key]; if (!op || !h) return false; const w = Array.isArray(v.value) ? v.value : [v.value]; return w.length > 0 && op(w, h); });
    return r.type === 'OR' ? res.some(Boolean) : res.every(Boolean);
  });
}

/**
 * Fingerprint: a client-sent `$exception_fingerprint` (string, or list joined with |) wins; then the first matching
 * project grouping rule (`rule:<key>`); otherwise the outer exception's type plus its top five in-app frames (function
 * and normalized filename, no line numbers), innermost first. With no frames, the type plus the normalized message.
 */
export async function fingerprintOf(props: Record<string, unknown>, list: ExceptionEntry[], rules: GroupingRule[] = []): Promise<string> {
  const custom = props.$exception_fingerprint;
  if (typeof custom === 'string' && custom.trim()) return 'custom:' + custom.trim().slice(0, 200);
  if (Array.isArray(custom) && custom.length) return 'custom:' + custom.map(String).join('|').slice(0, 200);
  for (const r of rules) if (r.enabled !== false && ruleMatches(r, list)) return 'rule:' + r.key;
  return defaultFingerprint(list);
}
/** The built-in fingerprint (no client fingerprint, no rules). */
export async function defaultFingerprint(list: ExceptionEntry[]): Promise<string> {
  const e = list[0] ?? {}; const type = String(e.type ?? 'Error');
  const frames = framesOf(e).slice().reverse();
  const inApp = frames.filter(f => f.in_app !== false); const use = (inApp.length ? inApp : frames).slice(0, 5);
  const parts = use.map(f => `${f.function ?? '?'}@${normalizeFilename(f.filename ?? f.abs_path)}`);
  return await sha(parts.length ? `${type}\n${parts.join('\n')}` : `${type}\n${normalizeMessage(String(e.value ?? ''))}`);
}
/** True when a frame could still be symbolicated (has a file and line and is not yet resolved). */
/** Frames a JavaScript source map can apply to: no platform, or a JavaScript / Node one (Python, Go, Rust frames arrive resolved). */
export const jsFrame = (f: Frame) => f.platform === undefined || f.platform === null || /javascript|node/i.test(String(f.platform));
export const unresolvedFrames = (list: ExceptionEntry[]) => list.some(e => framesOf(e).some(f => !f.resolved && !!(f.filename ?? f.abs_path) && !!f.lineno && jsFrame(f)));
/** Files (as in the frames) that still have unresolved frames. */
export const unresolvedFiles = (list: ExceptionEntry[]) => [...new Set(list.flatMap(e => framesOf(e).filter(f => !f.resolved && f.lineno && jsFrame(f)).map(f => f.filename ?? f.abs_path).filter((x): x is string => !!x)))];

/** A loaded source map for a frame filename, or null. */
export type MapLoader = (filename: string) => Promise<DecodedMap | null>;

/**
 * Resolves minified frames in place-copies: original file, line, column and surrounding source lines. A frame's
 * original function name is the name mapped at its caller's call site (the frame before it), the usual approach when
 * maps carry no scope data; the outermost frame (no caller) takes the enclosing declaration's name from sourcesContent.
 */
export async function symbolicate(list: ExceptionEntry[], load: MapLoader): Promise<{ list: ExceptionEntry[]; resolved: number }> {
  let resolved = 0;
  const out: ExceptionEntry[] = [];
  for (const e of list) {
    const frames = framesOf(e);
    const pos = await Promise.all(frames.map(async f => {
      const file = f.filename ?? f.abs_path; if (!file || !f.lineno || f.resolved || !jsFrame(f)) return null;
      const m = await load(file); if (!m) return null;
      const p = originalPosition(m, Number(f.lineno), Number(f.colno ?? 1)); return p ? { p, m } : null;
    }));
    const nf = frames.map((f, i) => {
      const r = pos[i]; if (!r) return f;
      resolved++;
      const caller = i > 0 ? pos[i - 1] : null;
      const fn = caller ? (caller.p.name ?? f.function ?? '?') : (enclosingName(r.m, r.p.sourceIndex, r.p.line) ?? f.function ?? '?');
      const ctx = contextLines(r.m, r.p.sourceIndex, r.p.line);
      const src = r.p.source.replace(/^webpack:\/\/\/?/, '').replace(/^(\.\.?\/)+/, '');
      return { ...f, filename: src, function: fn, lineno: r.p.line, colno: r.p.column, in_app: f.in_app !== false && !/node_modules\//.test(src), resolved: true,
        minified: { filename: f.filename, function: f.function, lineno: f.lineno, colno: f.colno }, ...(ctx ?? {}) } as Frame;
    });
    out.push({ ...e, stacktrace: { ...(e.stacktrace ?? {}), type: nf.some(f => f.resolved) ? 'resolved' : (e.stacktrace?.type ?? 'raw'), frames: nf } });
  }
  return { list: out, resolved };
}

/** One-line summary of the innermost in-app frame, e.g. "parsePrice (app-src.js:4)". */
export function topFrame(list: ExceptionEntry[]): string | null {
  const fr = framesOf(list[0] ?? {}).slice().reverse(); const f = fr.find(x => x.in_app !== false) ?? fr[0];
  if (!f) return null;
  return `${f.function ?? '?'} (${pathOf(f.filename ?? f.abs_path ?? '?').replace(/^\//, '')}${f.lineno ? ':' + f.lineno : ''})`;
}
