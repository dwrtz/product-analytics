// Feature flag evaluation (protocol.md "Feature flags"). Pure, apart from SHA-1 via Web Crypto.
export type PropFilter = { key: string; value?: unknown; operator?: string; type?: string };
export type FlagCondition = { properties?: PropFilter[]; rollout_percentage?: number | null; variant?: string | null };
export type FlagVariant = { key: string; name?: string; rollout_percentage: number };
export type FlagFilters = { groups?: FlagCondition[]; multivariate?: { variants: FlagVariant[] } | null; payloads?: Record<string, string> };
export type FlagDef = { id: number; key: string; name?: string; active: boolean; version: number; filters: FlagFilters };
export type FlagResult = { key: string; enabled: boolean; variant: string | null; reason: { code: string; condition_index: number | null; description: string }; metadata: { id: number; version: number; description: string | null; payload: string | null } };

const LONG_SCALE = 0xfffffffffffffff;

/** SHA-1 of prefix+id+salt; first 15 hex digits as an integer over 0xfffffffffffffff. */
export async function flagHash(prefix: string, id: string, salt: string): Promise<number> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(prefix + id + salt)));
  let hex = ''; for (let i = 0; i < 8; i++) hex += d[i].toString(16).padStart(2, '0');
  const v = BigInt('0x' + hex) >> 4n;
  return Number(v) / LONG_SCALE;
}

const str = (v: unknown) => typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

/** Matches one property filter against a property bag. Missing property: only is_not and is_not_set match. */
export function matchProperty(f: PropFilter, props: Record<string, unknown>): boolean {
  const op = f.operator ?? 'exact';
  const has = Object.prototype.hasOwnProperty.call(props, f.key) && props[f.key] !== undefined;
  if (op === 'is_set') return has;
  if (op === 'is_not_set') return !has;
  if (!has) return op === 'is_not' || op === 'not_icontains' || op === 'not_regex';
  const v = props[f.key];
  const targets = Array.isArray(f.value) ? f.value : [f.value];
  switch (op) {
    case 'exact': return targets.some(t => str(t).toLowerCase() === str(v).toLowerCase());
    case 'is_not': return !targets.some(t => str(t).toLowerCase() === str(v).toLowerCase());
    case 'icontains': return str(v).toLowerCase().includes(str(f.value).toLowerCase());
    case 'not_icontains': return !str(v).toLowerCase().includes(str(f.value).toLowerCase());
    case 'regex': case 'not_regex': {
      let re: RegExp; try { re = new RegExp(str(f.value)); } catch { return false; }
      return op === 'regex' ? re.test(str(v)) : !re.test(str(v));
    }
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = num(v), b = num(f.value);
      // Numeric only, as PostHog's flag service: a value that is not a number never matches.
      if (a === null || b === null) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    default: return false;
  }
}

/** Evaluates one active flag for a distinct id and a merged person property bag. */
export async function evaluateFlag(flag: FlagDef, distinctId: string, props: Record<string, unknown>): Promise<FlagResult> {
  const meta = (variant: string | null, enabled: boolean) => ({ id: flag.id, version: flag.version, description: flag.name ?? null, payload: enabled ? flag.filters.payloads?.[variant ?? 'true'] ?? null : null });
  const groups = flag.filters.groups?.length ? flag.filters.groups : [{ properties: [], rollout_percentage: 0 }];
  const variants = flag.filters.multivariate?.variants ?? [];
  let best: { code: string; i: number | null } = { code: 'no_condition_match', i: null };
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!(g.properties ?? []).every(p => matchProperty(p, props))) continue;
    const pct = g.rollout_percentage ?? 100;
    const inRollout = pct >= 100 ? true : distinctId === '' ? true : (await flagHash(flag.key + '.', distinctId, '')) <= pct / 100;
    if (!inRollout) { best = { code: 'out_of_rollout_bound', i }; continue; }
    let variant: string | null = null;
    if (variants.length) {
      if (g.variant && variants.some(v => v.key === g.variant)) variant = g.variant;
      else {
        const h = await flagHash(flag.key + '.', distinctId, 'variant'); let c = 0;
        for (const v of variants) { c += v.rollout_percentage / 100; if (h < c) { variant = v.key; break; } }
      }
    }
    return { key: flag.key, enabled: true, variant, reason: { code: 'condition_match', condition_index: i, description: `Matched condition set ${i + 1}` }, metadata: meta(variant, true) };
  }
  const desc = best.code === 'out_of_rollout_bound' ? 'Out of rollout bound' : 'No matching condition set';
  return { key: flag.key, enabled: false, variant: null, reason: { code: best.code, condition_index: best.i, description: desc }, metadata: meta(null, false) };
}
