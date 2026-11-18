import type { ProjectStore } from './store';
export interface Env {
  DB: D1Database;
  STORE: DurableObjectNamespace<ProjectStore>;
  INGEST: Queue<IngestMsg>;
  ASSETS: Fetcher;
  SITE_URL: string;
  ALLOWED_EMAILS: string;
  /** Retention in days for new projects; empty or 0 keeps events forever. */
  DEFAULT_RETENTION_DAYS?: string;
}
/** One queue message: events for one project, already normalized by the capture endpoint. */
export type IngestMsg = { pid: number; events: NormEvent[] };
export type NormEvent = {
  uuid: string; event: string; distinct_id: string; ts: number; properties: Record<string, unknown>;
  set?: Record<string, unknown>; set_once?: Record<string, unknown>; unset?: string[]; person: boolean; received_at: number;
};
export interface ProjectRow { id: number; name: string; api_token: string; timezone: string; retention_days: number; anonymize_ips: number; autocapture_opt_out: number; created_at: string }
export interface UserRow { id: number; email: string; name: string; pw_hash: string; pw_salt: string; created_at: string }

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}
export const nowIso = () => new Date().toISOString();
export const isoIn = (s: number) => new Date(Date.now() + s * 1000).toISOString();
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
export const origin = (env: Env) => env.SITE_URL.replace(/\/+$/, '');
/** The project's store stub, typed as the class (RPC types are too deep for tsc). */
export const storeFor = (env: Env, pid: number) => env.STORE.get(env.STORE.idFromName(`project:${pid}`)) as unknown as ProjectStore;
