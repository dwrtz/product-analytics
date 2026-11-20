// Source map v3 decoding (design.md "Error tracking"): written from the public Source Map Revision 3 proposal
// (https://tc39.es/ecma426/). Regular maps and indexed maps (`sections`, each with an inline `map`); sections that
// point at another file by `url` are rejected at upload.
export type SourceMapV3 = { version: number; file?: string; sourceRoot?: string; sources: (string | null)[]; sourcesContent?: (string | null)[]; names?: string[]; mappings: string; sections?: { offset: { line: number; column: number }; map: SourceMapV3 }[] };
/** One decoded segment: generated column, source index, original line, original column, name index (-1 when absent); all 0-based. */
export type Segment = [number, number, number, number, number];
export type DecodedMap = { sources: string[]; contents: (string | null)[]; names: string[]; lines: Segment[][] };
export type Position = { source: string; line: number; column: number; name: string | null; sourceIndex: number };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1); for (let i = 0; i < B64.length; i++) DIGIT[B64.charCodeAt(i)] = i;

export class SourceMapError extends Error {}

/** Checks the shape of an uploaded map; returns an error message or null. */
export function validateMap(m: unknown, depth = 0): string | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'source map must be a JSON object';
  const o = m as Record<string, unknown>;
  if (o.version !== 3) return 'only source map version 3 is supported';
  if (o.sections !== undefined) {
    if (depth > 0) return 'nested indexed source maps are not supported';
    if (!Array.isArray(o.sections) || !o.sections.length) return 'sections must be a non-empty list';
    if (o.sections.length > 10_000) return 'at most 10000 sections';
    let prev = -1;
    for (const [i, sec] of (o.sections as any[]).entries()) {
      if (!sec || typeof sec !== 'object') return `section ${i} must be an object`;
      if (sec.url !== undefined) return `section ${i} points at a url; upload maps with the map inline in each section`;
      const off = sec.offset; if (!off || !Number.isInteger(off.line) || !Number.isInteger(off.column) || off.line < 0 || off.column < 0) return `section ${i} needs offset { line, column } (whole numbers >= 0)`;
      const at = off.line * 1e7 + off.column; if (at <= prev) return 'sections must be sorted and must not overlap'; prev = at;
      const bad = validateMap(sec.map, depth + 1); if (bad) return `section ${i}: ${bad}`;
    }
    return null;
  }
  if (typeof o.mappings !== 'string') return 'mappings must be a string';
  if (!Array.isArray(o.sources)) return 'sources must be a list';
  return null;
}

/**
 * Indexed map: decodes each section's map and shifts it by the section offset (0-based generated line and column; the
 * column only shifts the section's first line), concatenating sources and names. Segments of a section never reach
 * past the next section's start.
 */
function decodeSections(m: { sections: { offset: { line: number; column: number }; map: SourceMapV3 }[] }): DecodedMap {
  const out: DecodedMap = { sources: [], contents: [], names: [], lines: [] };
  const secs = m.sections;
  for (let k = 0; k < secs.length; k++) {
    const { offset, map } = secs[k]; const d = decodeMap(map);
    const next = secs[k + 1]?.offset;
    const srcBase = out.sources.length, nameBase = out.names.length;
    out.sources.push(...d.sources); out.contents.push(...d.sources.map((_, i) => d.contents[i] ?? null)); out.names.push(...d.names);
    d.lines.forEach((segs, li) => {
      const line = offset.line + li;
      while (out.lines.length <= line) out.lines.push([]);
      for (const sg of segs) {
        const col = sg[0] + (li === 0 ? offset.column : 0);
        if (next && (line > next.line || (line === next.line && col >= next.column))) continue;
        out.lines[line].push([col, sg[1] + srcBase, sg[2], sg[3], sg[4] >= 0 ? sg[4] + nameBase : -1]);
      }
    });
  }
  for (const l of out.lines) l.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Decodes the VLQ `mappings` string into per-line segment lists (sorted by generated column). */
export function decodeMap(m: SourceMapV3): DecodedMap {
  const err = validateMap(m); if (err) throw new SourceMapError(err);
  if (Array.isArray(m.sections)) return decodeSections(m as any);
  const root = m.sourceRoot ? m.sourceRoot.replace(/\/?$/, '/') : '';
  const sources = m.sources.map(s => (s && root && !/^[a-z]+:\/\//i.test(s) && !s.startsWith('/') ? root + s : (s ?? '')));
  const lines: Segment[][] = []; let line: Segment[] = [];
  let src = 0, oLine = 0, oCol = 0, name = 0;
  const str = m.mappings; let i = 0; const n = str.length;
  let genCol = 0;
  const vlq = (): number => {
    let result = 0, shift = 0, cont = 0;
    do {
      if (i >= n) throw new SourceMapError('truncated mappings');
      const c = str.charCodeAt(i++); const d = c < 128 ? DIGIT[c] : -1;
      if (d < 0) throw new SourceMapError('invalid base64 in mappings');
      cont = d & 32; result += (d & 31) * 2 ** shift; shift += 5;
    } while (cont);
    const neg = result % 2 === 1; const v = Math.floor(result / 2);
    return neg ? -v : v;
  };
  while (i < n) {
    const c = str[i];
    if (c === ';') { line.sort((a, b) => a[0] - b[0]); lines.push(line); line = []; genCol = 0; i++; continue; }
    if (c === ',') { i++; continue; }
    genCol += vlq();
    if (i < n && str[i] !== ',' && str[i] !== ';') {
      src += vlq(); oLine += vlq(); oCol += vlq();
      let nm = -1;
      if (i < n && str[i] !== ',' && str[i] !== ';') { name += vlq(); nm = name; }
      line.push([genCol, src, oLine, oCol, nm]);
    }
  }
  line.sort((a, b) => a[0] - b[0]); lines.push(line);
  return { sources, contents: (m.sourcesContent ?? []).map(x => typeof x === 'string' ? x : null), names: m.names ?? [], lines };
}

/** Original position of a generated 1-based line and column (stack trace convention), or null. */
export function originalPosition(d: DecodedMap, line1: number, col1: number): Position | null {
  const segs = d.lines[line1 - 1]; if (!segs || !segs.length) return null;
  const col = Math.max(0, col1 - 1);
  let lo = 0, hi = segs.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid][0] <= col) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  if (best < 0) return null;
  const s = segs[best];
  return { source: d.sources[s[1]] ?? '', line: s[2] + 1, column: s[3] + 1, name: s[4] >= 0 ? d.names[s[4]] ?? null : null, sourceIndex: s[1] };
}

/** Lines around an original position from sourcesContent: `before` lines, the line, `after` lines. */
export function contextLines(d: DecodedMap, sourceIndex: number, line1: number, before = 5, after = 3) {
  const text = d.contents[sourceIndex]; if (typeof text !== 'string') return null;
  const all = text.split(/\r?\n/); const at = line1 - 1; if (at < 0 || at >= all.length) return null;
  const cut = (s: string) => s.length > 300 ? s.slice(0, 300) + '…' : s;
  return { pre_context: all.slice(Math.max(0, at - before), at).map(cut), context_line: cut(all[at]), post_context: all.slice(at + 1, at + 1 + after).map(cut) };
}

/**
 * Best-effort name of the function declared around an original line, from the map's sourcesContent: the nearest
 * `function name(`, `name(…) {` method or `name = (…) =>` / `name: function` above the line. Used only for the
 * outermost frame, which has no caller call site to take a name from (e.g. an async function after an await).
 */
export function enclosingName(d: DecodedMap, sourceIndex: number, line1: number): string | null {
  const text = d.contents[sourceIndex]; if (typeof text !== 'string') return null;
  const all = text.split(/\r?\n/); const kw = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with']);
  for (let i = Math.min(line1 - 1, all.length - 1), n = 0; i >= 0 && n < 200; i--, n++) {
    const l = all[i];
    let m = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(l)
      ?? /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(l)
      ?? /^\s*(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(l);
    if (m && !kw.has(m[1])) return m[1];
  }
  return null;
}
