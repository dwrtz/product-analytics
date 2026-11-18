// Project token lookup with a short per-isolate cache (capture and /flags are hot paths).
import { Env, ProjectRow } from './env';
const cache = new Map<string, { at: number; row: ProjectRow | null }>();
const TTL = 30_000;
export async function projectByToken(env: Env, token: string): Promise<ProjectRow | null> {
  const c = cache.get(token);
  if (c && Date.now() - c.at < TTL) return c.row;
  const row = await env.DB.prepare('SELECT * FROM projects WHERE api_token = ?').bind(token).first<ProjectRow>();
  cache.set(token, { at: Date.now(), row: row ?? null });
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return row ?? null;
}
export const forgetToken = (token: string) => cache.delete(token);
export function validToken(t: unknown): t is string {
  return typeof t === 'string' && t.length > 0 && t.length <= 64 && /^[\x01-\x7f]+$/.test(t) && !t.startsWith('phx_');
}
