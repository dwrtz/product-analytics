// Autocapture element chains and CSS selector matching for actions (design.md "Actions"). Pure.
// `$elements_chain` (posthog-js with elementsChainAsString, observed): elements from the clicked one up to <body>, separated
// by ';'. Each is `tag.class1.class2:key="value"key="value"…` with keys text, href, nth-child, nth-of-type, attr_id and
// attr__<name>; quotes inside values are backslash-escaped.
export type El = { tag: string; classes: string[]; text?: string; href?: string; id?: string; nthChild?: number; nthOfType?: number; attrs: Record<string, string> };

function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '"') q = !q;
    if (c === sep && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
export function parseElementsChain(chain: string): El[] {
  if (typeof chain !== 'string' || !chain) return [];
  return splitTop(chain, ';').filter(Boolean).map(part => {
    let head = part, rest = '';
    let q = false;
    for (let i = 0; i < part.length; i++) { const c = part[i]; if (c === '\\') { i++; continue; } if (c === '"') q = !q; if (c === ':' && !q) { head = part.slice(0, i); rest = part.slice(i + 1); break; } }
    const [tag, ...classes] = head.split('.');
    const el: El = { tag: tag || '', classes: classes.filter(Boolean), attrs: {} };
    const re = /([\w$@:.-]+)="((?:[^"\\]|\\.)*)"/g; let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
      const k = m[1], v = m[2].replace(/\\(.)/g, '$1');
      if (k === 'text') el.text = v; else if (k === 'href') el.href = v; else if (k === 'attr_id') el.id = v;
      else if (k === 'nth-child') el.nthChild = Number(v); else if (k === 'nth-of-type') el.nthOfType = Number(v);
      else if (k.startsWith('attr__')) el.attrs[k.slice(6)] = v;
    }
    if (el.id === undefined && el.attrs.id) el.id = el.attrs.id;
    if (!el.classes.length && el.attrs.class) el.classes = el.attrs.class.split(/\s+/).filter(Boolean);
    return el;
  });
}

// ---------- selectors: compound selectors (tag, .class, #id, [attr], [attr=v], [attr*=v], [attr^=v], [attr$=v],
// :nth-child(n), :nth-of-type(n), *) joined by descendant (space) or child (>) combinators ----------
type Simple = { tag?: string; classes: string[]; id?: string; attrs: { name: string; op: string; value?: string }[]; nthChild?: number; nthOfType?: number };
export type Selector = { parts: Simple[]; combs: (' ' | '>')[] };
export class SelectorError extends Error {}
export function parseSelector(src: string): Selector {
  const s = String(src ?? '').trim(); if (!s || s.length > 1000) throw new SelectorError('empty or too long selector');
  const parts: Simple[] = []; const combs: (' ' | '>')[] = []; let i = 0;
  const ident = () => { const m = /^-?[_a-zA-Z\u00a0-\uffff][\w\u00a0-\uffff-]*/.exec(s.slice(i)) ?? /^\*/.exec(s.slice(i)); if (!m) throw new SelectorError(`unexpected "${s.slice(i, i + 10)}" in selector`); i += m[0].length; return m[0]; };
  const ws = () => { const st = i; while (i < s.length && /\s/.test(s[i])) i++; return i > st; };
  for (;;) {
    const cur: Simple = { classes: [], attrs: [] }; let any = false;
    if (i < s.length && (/[a-zA-Z*]/.test(s[i]))) { const t = ident(); if (t !== '*') cur.tag = t.toLowerCase(); any = true; }
    while (i < s.length) {
      const c = s[i];
      if (c === '.') { i++; cur.classes.push(ident()); any = true; }
      else if (c === '#') { i++; cur.id = ident(); any = true; }
      else if (c === '[') {
        const m = /^\[\s*([\w:-]+)\s*(?:([*^$~|]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]\s]+)))?\s*\]/.exec(s.slice(i));
        if (!m) throw new SelectorError('bad attribute selector'); i += m[0].length;
        cur.attrs.push({ name: m[1], op: m[2] ?? 'has', value: m[3] ?? m[4] ?? m[5] }); any = true;
      } else if (c === ':') {
        const m = /^:(nth-child|nth-of-type)\(\s*(\d+)\s*\)/.exec(s.slice(i)); if (!m) throw new SelectorError(`unsupported pseudo-class "${s.slice(i, i + 15)}"`);
        i += m[0].length; if (m[1] === 'nth-child') cur.nthChild = Number(m[2]); else cur.nthOfType = Number(m[2]); any = true;
      } else break;
    }
    if (!any) throw new SelectorError('bad selector');
    parts.push(cur);
    const hadWs = ws();
    if (i >= s.length) break;
    if (s[i] === '>') { i++; ws(); combs.push('>'); }
    else if (s[i] === ',') throw new SelectorError('selector lists (",") are not supported; add another step');
    else if (hadWs) combs.push(' ');
    else throw new SelectorError(`unexpected "${s[i]}" in selector`);
  }
  if (parts.length > 20) throw new SelectorError('selector too long');
  return { parts, combs };
}
function simpleMatches(p: Simple, el: El): boolean {
  if (p.tag && el.tag.toLowerCase() !== p.tag) return false;
  if (p.id !== undefined && el.id !== p.id) return false;
  for (const c of p.classes) if (!el.classes.includes(c)) return false;
  if (p.nthChild !== undefined && el.nthChild !== p.nthChild) return false;
  if (p.nthOfType !== undefined && el.nthOfType !== p.nthOfType) return false;
  for (const a of p.attrs) {
    const v = a.name === 'id' ? el.id : a.name === 'href' ? (el.attrs.href ?? el.href) : a.name === 'class' ? (el.attrs.class ?? el.classes.join(' ')) : el.attrs[a.name];
    if (v === undefined) return false;
    const w = a.value ?? '';
    switch (a.op) {
      case 'has': break;
      case '=': if (v !== w) return false; break;
      case '*=': if (!v.includes(w)) return false; break;
      case '^=': if (!v.startsWith(w)) return false; break;
      case '$=': if (!v.endsWith(w)) return false; break;
      case '~=': if (!v.split(/\s+/).includes(w)) return false; break;
      case '|=': if (v !== w && !v.startsWith(w + '-')) return false; break;
    }
  }
  return true;
}
/**
 * As PostHog's selector matching on element chains: the last compound must match an element of the chain (the clicked
 * element or one of its ancestors), and each earlier compound an ancestor of it (any for " ", the parent for ">").
 */
export function selectorMatches(sel: Selector, chain: El[]): boolean {
  const n = sel.parts.length;
  const from = (pi: number, ei: number): boolean => {
    if (pi < 0) return true;
    if (!simpleMatches(sel.parts[pi], chain[ei])) return false;
    if (pi === 0) return true;
    const comb = sel.combs[pi - 1];
    if (comb === '>') return ei + 1 < chain.length && from(pi - 1, ei + 1);
    for (let k = ei + 1; k < chain.length; k++) if (from(pi - 1, k)) return true;
    return false;
  };
  for (let e = 0; e < chain.length; e++) if (from(n - 1, e)) return true;
  return false;
}
