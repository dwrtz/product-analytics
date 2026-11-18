// Actions: named matchers over events (design.md "Actions"), as PostHog's action steps. An event matches an action when it
// matches any step; a step matches when every condition it sets holds. Pure; the event SQL compiles the simple conditions
// and EventShard evaluates the rest (selector, regex, href) with stepMatches.
import { parseElementsChain, parseSelector, selectorMatches, SelectorError } from './elements';
export type StringMatch = 'exact' | 'contains' | 'regex';
export type ActionStep = {
  event?: string | null; url?: string | null; url_matching?: StringMatch; selector?: string | null; text?: string | null; text_matching?: StringMatch;
  href?: string | null; href_matching?: StringMatch; properties?: { key: string; value?: unknown; operator?: string; type?: string }[];
};
export class ActionError extends Error {}
const MATCH = new Set(['exact', 'contains', 'regex']);
export function cleanStep(s: any): ActionStep {
  if (!s || typeof s !== 'object') throw new ActionError('each step must be an object');
  const str = (v: unknown, max = 1000) => v === undefined || v === null || v === '' ? null : String(v).slice(0, max);
  const step: ActionStep = { event: str(s.event, 400), url: str(s.url), url_matching: MATCH.has(s.url_matching) ? s.url_matching : 'contains', selector: str(s.selector),
    text: str(s.text), text_matching: MATCH.has(s.text_matching) ? s.text_matching : 'exact', href: str(s.href), href_matching: MATCH.has(s.href_matching) ? s.href_matching : 'exact',
    properties: Array.isArray(s.properties) ? s.properties.filter((f: any) => f && f.key).map((f: any) => ({ key: String(f.key), value: f.value, operator: f.operator ?? 'exact', type: f.type === 'person' ? 'person' : 'event' })) : [] };
  if (step.selector) { try { parseSelector(step.selector); } catch (e) { throw new ActionError(e instanceof SelectorError ? e.message : 'bad selector'); } }
  for (const [v, m] of [[step.url, step.url_matching], [step.text, step.text_matching], [step.href, step.href_matching]] as [string | null, string][]) {
    if (v && m === 'regex') { try { new RegExp(v); } catch { throw new ActionError(`invalid regex ${v}`); } }
  }
  if (!step.event && !step.url && !step.selector && !step.text && !step.href && !step.properties?.length) throw new ActionError('a step needs at least one condition');
  return step;
}
/** Conditions that SQL cannot express here (SQLite has no regex; selectors need the chain parsed). */
export const needsJs = (s: ActionStep) => !!(s.selector || s.href || (s.url && s.url_matching === 'regex') || (s.text && s.text_matching === 'regex'));
const strMatch = (v: unknown, want: string, how: StringMatch | undefined) => {
  if (v === undefined || v === null) return false; const t = String(v);
  if (how === 'regex') { try { return new RegExp(want).test(t); } catch { return false; } }
  if (how === 'contains') return t.toLowerCase().includes(want.toLowerCase());
  return t === want;
};
/** The JS-only conditions of a step (the SQL side checks event, exact/contains url and text, and properties). */
export function jsConditionsMatch(s: ActionStep, props: Record<string, unknown>): boolean {
  if (s.url && s.url_matching === 'regex' && !strMatch(props.$current_url, s.url, 'regex')) return false;
  if (s.text && s.text_matching === 'regex' && !strMatch(props.$el_text, s.text, 'regex')) return false;
  if (s.selector || s.href) {
    const chain = parseElementsChain(String(props.$elements_chain ?? ''));
    if (!chain.length) return false;
    if (s.selector && !selectorMatches(parseSelector(s.selector), chain)) return false;
    if (s.href) { const a = chain.find(e => (e.href ?? e.attrs.href) !== undefined); if (!a || !strMatch(a.href ?? a.attrs.href, s.href, s.href_matching)) return false; }
  }
  return true;
}
