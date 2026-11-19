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

/**
 * Fingerprint: a client-sent `$exception_fingerprint` (string, or list joined with |) wins; otherwise the outer
 * exception's type plus its top five in-app frames (function and normalized filename, no line numbers), innermost first.
 * With no frames, the type plus the normalized message.
 */
export async function fingerprintOf(props: Record<string, unknown>, list: ExceptionEntry[]): Promise<string> {
  const custom = props.$exception_fingerprint;
  if (typeof custom === 'string' && custom.trim()) return 'custom:' + custom.trim().slice(0, 200);
  if (Array.isArray(custom) && custom.length) return 'custom:' + custom.map(String).join('|').slice(0, 200);
  const e = list[0] ?? {}; const type = String(e.type ?? 'Error');
  const frames = framesOf(e).slice().reverse();
  const inApp = frames.filter(f => f.in_app !== false); const use = (inApp.length ? inApp : frames).slice(0, 5);
  const parts = use.map(f => `${f.function ?? '?'}@${normalizeFilename(f.filename ?? f.abs_path)}`);
  return await sha(parts.length ? `${type}\n${parts.join('\n')}` : `${type}\n${normalizeMessage(String(e.value ?? ''))}`);
}

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
      const file = f.filename ?? f.abs_path; if (!file || !f.lineno || f.resolved) return null;
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
