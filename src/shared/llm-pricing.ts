// Built-in model prices for LLM analytics (design.md "LLM analytics"), used only when an event carries no
// `$ai_total_cost_usd`. USD per 1M tokens: input, output and cached (prompt-cache read) input. Taken from the providers'
// public price pages as of 2026-11 (standard tier, no batch or regional discounts); they change, so SDK-sent costs win.
export type ModelPrice = { input: number; output: number; cached: number };
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-5': { input: 1.25, output: 10, cached: 0.125 }, 'gpt-5-mini': { input: 0.25, output: 2, cached: 0.025 }, 'gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005 },
  'gpt-4.1': { input: 2, output: 8, cached: 0.5 }, 'gpt-4.1-mini': { input: 0.4, output: 1.6, cached: 0.1 }, 'gpt-4.1-nano': { input: 0.1, output: 0.4, cached: 0.025 },
  'gpt-4o': { input: 2.5, output: 10, cached: 1.25 }, 'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075 },
  'gpt-4-turbo': { input: 10, output: 30, cached: 10 }, 'gpt-3.5-turbo': { input: 0.5, output: 1.5, cached: 0.5 },
  'o1': { input: 15, output: 60, cached: 7.5 }, 'o1-mini': { input: 1.1, output: 4.4, cached: 0.55 }, 'o3': { input: 2, output: 8, cached: 0.5 }, 'o3-mini': { input: 1.1, output: 4.4, cached: 0.55 }, 'o4-mini': { input: 1.1, output: 4.4, cached: 0.275 },
  'text-embedding-3-small': { input: 0.02, output: 0, cached: 0.02 }, 'text-embedding-3-large': { input: 0.13, output: 0, cached: 0.13 }, 'text-embedding-ada-002': { input: 0.1, output: 0, cached: 0.1 },
  // Anthropic
  'claude-opus-4-5': { input: 5, output: 25, cached: 0.5 }, 'claude-opus-4-1': { input: 15, output: 75, cached: 1.5 }, 'claude-opus-4': { input: 15, output: 75, cached: 1.5 },
  'claude-sonnet-4-5': { input: 3, output: 15, cached: 0.3 }, 'claude-sonnet-4': { input: 3, output: 15, cached: 0.3 }, 'claude-haiku-4-5': { input: 1, output: 5, cached: 0.1 },
  'claude-3-7-sonnet': { input: 3, output: 15, cached: 0.3 }, 'claude-3-5-sonnet': { input: 3, output: 15, cached: 0.3 }, 'claude-3-5-haiku': { input: 0.8, output: 4, cached: 0.08 },
  'claude-3-opus': { input: 15, output: 75, cached: 1.5 }, 'claude-3-haiku': { input: 0.25, output: 1.25, cached: 0.03 },
  // Google Gemini
  'gemini-2.5-pro': { input: 1.25, output: 10, cached: 0.31 }, 'gemini-2.5-flash': { input: 0.3, output: 2.5, cached: 0.075 }, 'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cached: 0.025 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cached: 0.025 }, 'gemini-2.0-flash-lite': { input: 0.075, output: 0.3, cached: 0.075 },
  'gemini-1.5-pro': { input: 1.25, output: 5, cached: 0.3125 }, 'gemini-1.5-flash': { input: 0.075, output: 0.3, cached: 0.01875 }, 'text-embedding-004': { input: 0, output: 0, cached: 0 }, 'gemini-embedding-001': { input: 0.15, output: 0, cached: 0.15 },
  // xAI Grok
  'grok-4': { input: 3, output: 15, cached: 0.75 }, 'grok-4-fast': { input: 0.2, output: 0.5, cached: 0.05 }, 'grok-code-fast-1': { input: 0.2, output: 1.5, cached: 0.02 },
  'grok-3': { input: 3, output: 15, cached: 0.75 }, 'grok-3-mini': { input: 0.3, output: 0.5, cached: 0.075 }, 'grok-2': { input: 2, output: 10, cached: 2 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1, cached: 0.07 }, 'deepseek-reasoner': { input: 0.55, output: 2.19, cached: 0.14 }, 'deepseek-v3': { input: 0.27, output: 1.1, cached: 0.07 }, 'deepseek-r1': { input: 0.55, output: 2.19, cached: 0.14 },
  // Meta Llama (typical hosted price)
  'llama-4-maverick': { input: 0.27, output: 0.85, cached: 0.27 }, 'llama-4-scout': { input: 0.18, output: 0.59, cached: 0.18 },
  'llama-3.3-70b': { input: 0.6, output: 0.6, cached: 0.6 }, 'llama-3.1-405b': { input: 3, output: 3, cached: 3 }, 'llama-3.1-70b': { input: 0.6, output: 0.6, cached: 0.6 }, 'llama-3.1-8b': { input: 0.18, output: 0.18, cached: 0.18 },
};
const KEYS = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);
/**
 * Normalized model id: lower case, without a provider or path prefix ("openai/", "models/", "us.anthropic.") or a
 * trailing date or version stamp (-20250514, -2024-08-06, @20240620, -latest, -v1:0).
 */
export function normalizeModel(m: string): string {
  let s = m.trim().toLowerCase();
  s = s.replace(/^.*\//, '').replace(/^(?:[a-z]{2}\.)?(?:anthropic|meta|amazon|google|xai|openai)\./, '');
  s = s.replace(/(-v\d+(:\d+)?|@\d{8}|-latest|-preview(-\d{2}-\d{2,4})?|-exp(-\d+)?)$/g, '').replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return s.replace(/-instruct(-turbo)?$/, '');
}
/** Price for a model: exact normalized id, else the longest known id it starts with (gpt-4o-mini-2024-07-18 -> gpt-4o-mini). */
export function priceOf(model: unknown): { key: string; price: ModelPrice } | null {
  if (typeof model !== 'string' || !model.trim()) return null;
  const n = normalizeModel(model);
  if (MODEL_PRICES[n]) return { key: n, price: MODEL_PRICES[n] };
  const k = KEYS.find(k => n.startsWith(k + '-') || n.startsWith(k + '.') || n === k || n.startsWith(k + ':'));
  return k ? { key: k, price: MODEL_PRICES[k] } : null;
}
const num = (v: unknown) => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0; };
/**
 * Cost in USD of one generation or embedding. `$ai_total_cost_usd` (or input + output cost) from the SDK wins; else the
 * built-in price. Anthropic reports cache reads apart from `$ai_input_tokens`; other providers include them in it.
 */
export function costOf(p: Record<string, unknown>): { usd: number | null; source: 'sdk' | 'pricing' | null } {
  const total = p.$ai_total_cost_usd;
  if (total !== undefined && total !== null && Number.isFinite(Number(total))) return { usd: Number(total), source: 'sdk' };
  const has = (v: unknown) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
  if (has(p.$ai_input_cost_usd) || has(p.$ai_output_cost_usd)) return { usd: num(p.$ai_input_cost_usd) + num(p.$ai_output_cost_usd), source: 'sdk' };
  const pr = priceOf(p.$ai_model); if (!pr) return { usd: null, source: null };
  const inTok = num(p.$ai_input_tokens), outTok = num(p.$ai_output_tokens), cached = num(p.$ai_cache_read_input_tokens), write = num(p.$ai_cache_creation_input_tokens);
  const anthropic = /anthropic|claude/i.test(String(p.$ai_provider ?? '') + String(p.$ai_model ?? ''));
  const uncached = anthropic ? inTok + write : Math.max(0, inTok - cached);
  const usd = (uncached * pr.price.input + cached * pr.price.cached + outTok * pr.price.output) / 1e6;
  return { usd, source: 'pricing' };
}
