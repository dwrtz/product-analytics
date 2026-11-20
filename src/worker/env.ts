import type { ProjectStore } from './store';
import type { EventShard } from './shard';
export interface Env {
  DB: D1Database;
  STORE: DurableObjectNamespace<ProjectStore>;
  SHARDS: DurableObjectNamespace<EventShard>;
  /** Session replay chunks and (on the live deploy) static SDK files. */
  REPLAY: R2Bucket;
  INGEST: Queue<IngestMsg>;
  ASSETS: Fetcher;
  SITE_URL: string;
  ALLOWED_EMAILS: string;
  /** Retention in days for new projects; empty or 0 keeps events forever. */
  DEFAULT_RETENTION_DAYS?: string;
  /** Event shard period for new projects: month (default) or day (tests). */
  SHARD_PERIOD?: string;
  /** Days to keep session recordings (default 30); 0 keeps them as long as the project's events. */
  REPLAY_RETENTION_DAYS?: string;
  /** Optional Basin Pipelines stream (cold tier, design.md "Cold tier"); every ingested event is also sent here. */
  COLD_STREAM?: { send(records: unknown[]): Promise<void> };
  /** Cold-tier queries (Basin SQL): an API token secret with Basin SQL read, Basin Catalog and R2 access to BASIN_BUCKET. */
  BASIN_TOKEN?: string;
  BASIN_ACCOUNT_ID?: string;
  /** R2 bucket with Basin Catalog enabled that the pipeline's Iceberg sink writes to. */
  BASIN_BUCKET?: string;
  /** Iceberg table as namespace.table (default analytics.events). */
  BASIN_TABLE?: string;
  /** Optional comma-separated hostnames that only receive SDK traffic (design.md "Hostnames"); empty = none. */
  INGEST_HOSTS?: string;
  /** Optional Cloudflare Email Sending binding (send_email) for alert emails (design.md "Alerts"). */
  EMAIL?: { send(m: { from: string; to: string | string[]; subject: string; text?: string; html?: string }): Promise<unknown> };
  /** Sender address for alert emails, on a domain onboarded to Email Sending; unset = in-app alerts only. */
  ALERT_EMAIL_FROM?: string;
  /** Optional read-only public demo (design.md "Public demo"): "1" lets signed-out visitors browse projects marked
   * public_demo, read-only, with owner-only data redacted. Off by default. */
  PUBLIC_DEMO?: string;
}
/** One queue message: events for one project, already normalized by the capture endpoint. */
export type IngestMsg = { pid: number; events?: NormEvent[]; replay?: import('./replay').ReplayMeta[] };
export type NormEvent = {
  uuid: string; event: string; distinct_id: string; ts: number; properties: Record<string, unknown>;
  set?: Record<string, unknown>; set_once?: Record<string, unknown>; unset?: string[]; person: boolean; received_at: number;
};
export interface ProjectRow { id: number; name: string; api_token: string; timezone: string; retention_days: number; anonymize_ips: number; autocapture_opt_out: number; session_recording?: number; replay_config?: string | null; heatmaps?: number; limits?: string | null; cap_state?: string | null; error_tracking?: number; public_demo?: number; created_at: string }
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
/** True when the request's hostname is listed in INGEST_HOSTS (never for the SITE_URL hostname itself). */
export const ingestHost = (env: Env, url: URL) => {
  const h = url.hostname.toLowerCase();
  if (!env.INGEST_HOSTS || h === new URL(origin(env)).hostname.toLowerCase()) return false;
  return env.INGEST_HOSTS.split(',').some(x => x.trim().toLowerCase() === h);
};
/** The project's store stub, typed as the class (RPC types are too deep for tsc). */
export const storeFor = (env: Env, pid: number) => env.STORE.get(env.STORE.idFromName(`project:${pid}`)) as unknown as ProjectStore;
/** True when the instance runs the read-only public demo (PUBLIC_DEMO=1). */
export const publicDemo = (env: Env) => env.PUBLIC_DEMO === '1';
