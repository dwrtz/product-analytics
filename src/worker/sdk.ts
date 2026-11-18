// SDK-facing endpoints besides capture: /flags, /decide, remote config, and stubs for products out of scope (spec R4, R5).
import { Env, ProjectRow, json, storeFor } from './env';
import { cors } from './capture';
import { decodeBody } from '../shared/decode';
import { projectByToken, validToken } from './projects';
import { uuidv7 } from '../shared/ids';
import { recordingConfig, performanceConfig } from './replay';
import { authenticate } from './auth';

export function remoteConfig(p: ProjectRow, hasFlags: boolean, hasSurveys = false) {
  return {
    token: p.api_token, supportedCompression: ['gzip', 'gzip-js'], hasFeatureFlags: hasFlags,
    analytics: { endpoint: '/i/v0/e/' }, elementsChainAsString: true, defaultIdentifiedOnly: true,
    autocapture_opt_out: !!p.autocapture_opt_out, autocaptureExceptions: false, captureDeadClicks: !!p.heatmaps, capturePerformance: performanceConfig(p),
    sessionRecording: recordingConfig(p), heatmaps: !!p.heatmaps, surveys: hasSurveys, productTours: false, siteApps: [],
  };
}

export async function handleConfig(req: Request, env: Env, token: string, js: boolean): Promise<Response> {
  const p = validToken(token) ? await projectByToken(env, token) : null;
  if (!p) return js ? new Response('/* unknown project */', { status: 404, headers: { 'content-type': 'application/javascript', ...cors(req) } }) : json({ type: 'authentication_error', code: 'invalid_api_key', detail: 'Unknown project token.' }, 404, cors(req));
  const st = storeFor(env, p.id);
  const cfg = remoteConfig(p, await st.hasActiveFlags(), await st.hasActiveSurveys());
  const headers = { ...cors(req), 'cache-control': 'public, max-age=300' };
  if (!js) return json(cfg, 200, headers);
  const body = `(function(){window._POSTHOG_REMOTE_CONFIG=window._POSTHOG_REMOTE_CONFIG||{};window._POSTHOG_REMOTE_CONFIG[${JSON.stringify(p.api_token)}]={config:${JSON.stringify(cfg)},siteApps:[]}})();`;
  return new Response(body, { headers: { 'content-type': 'application/javascript', ...headers } });
}

export async function handleFlags(req: Request, env: Env, url: URL, legacyDecide: boolean): Promise<Response> {
  let body: any = {};
  if (req.method === 'POST') {
    try {
      const text = await decodeBody(new Uint8Array(await req.arrayBuffer()), { compression: url.searchParams.get('compression'), contentType: req.headers.get('content-type'), contentEncoding: req.headers.get('content-encoding') });
      body = text.trim() ? JSON.parse(text) : {};
    } catch { return json({ type: 'validation_error', code: 'malformed_data', detail: 'Malformed request data.' }, 400, cors(req)); }
  }
  const token = body.token ?? body.api_key ?? url.searchParams.get('token') ?? url.searchParams.get('api_key');
  if (!validToken(token)) return json({ type: 'authentication_error', code: 'invalid_api_key', detail: 'Project API key invalid.' }, 401, cors(req));
  const p = await projectByToken(env, token);
  if (!p) return json({ type: 'authentication_error', code: 'invalid_api_key', detail: 'Project API key invalid.' }, 401, cors(req));
  let did = body.distinct_id; if (typeof did === 'number') did = String(did);
  const store = storeFor(env, p.id);
  // posthog-js sends `$anon_distinct_id` once after identify (experience continuity, protocol.md "Flags").
  const anon = typeof body.$anon_distinct_id === 'string' || typeof body.$anon_distinct_id === 'number' ? String(body.$anon_distinct_id) : null;
  const flags = typeof did === 'string' && did ? await store.evaluateFlags(did, (body.person_properties && typeof body.person_properties === 'object') ? body.person_properties : {}, Array.isArray(body.flag_keys_to_evaluate) ? body.flag_keys_to_evaluate.map(String) : null, anon) : [];
  const featureFlags: Record<string, string | boolean> = {}; const featureFlagPayloads: Record<string, string> = {}; const byKey: Record<string, unknown> = {};
  for (const f of flags) {
    byKey[f.key] = f;
    featureFlags[f.key] = f.enabled ? (f.variant ?? true) : false;
    if (f.enabled && f.metadata.payload !== null) featureFlagPayloads[f.key] = f.metadata.payload;
  }
  const out: Record<string, unknown> = { flags: byKey, featureFlags, featureFlagPayloads, errorsWhileComputingFlags: typeof did !== 'string' || !did, requestId: uuidv7(), evaluatedAt: Date.now() };
  if (legacyDecide || url.searchParams.get('config') === 'true') Object.assign(out, remoteConfig(p, flags.length > 0, await store.hasActiveSurveys()), { config: { enable_collect_everything: !p.autocapture_opt_out } });
  return json(out, 200, cors(req));
}

/**
 * Flag definitions for server SDK local evaluation (protocol.md "Local evaluation"): posthog-node 5+ asks
 * GET /flags/definitions?token=<project token>&send_cohorts with `Authorization: Bearer <personal API key>`; older SDKs use
 * /api/feature_flag/local_evaluation. Answers carry an ETag and honour If-None-Match with 304.
 */
export async function handleLocalEvaluation(req: Request, env: Env, url: URL, project?: ProjectRow): Promise<Response> {
  if (req.method !== 'GET') return json({ type: 'invalid_request', code: 'method_not_allowed', detail: 'Use GET.' }, 405);
  const auth = req.headers.get('authorization')?.startsWith('Bearer ') ? await authenticate(env, req) : null;
  if (!auth) return json({ type: 'authentication_error', code: 'not_authenticated', detail: 'A personal API key is required (Authorization: Bearer phx_...).' }, 401);
  let p = project ?? null;
  if (!p) {
    const token = url.searchParams.get('token') ?? url.searchParams.get('api_key');
    if (!validToken(token)) return json({ type: 'authentication_error', code: 'missing_api_key', detail: 'Project token (token=) is required.' }, 401);
    p = await projectByToken(env, token);
    if (!p) return json({ type: 'authentication_error', code: 'invalid_api_key', detail: 'Project API key invalid.' }, 401);
  }
  const body = JSON.stringify(await storeFor(env, p.id).flagDefinitions(url.searchParams.has('send_cohorts')));
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body)));
  const etag = '"' + [...d].map(x => x.toString(16).padStart(2, '0')).join('') + '"';
  const inm = req.headers.get('if-none-match');
  if (inm && inm.split(',').map(s => s.trim().replace(/^W\//, '')).includes(etag)) return new Response(null, { status: 304, headers: { etag } });
  return new Response(body, { headers: { 'content-type': 'application/json', etag, 'cache-control': 'no-cache' } });
}

/** Endpoints for products this build does not have: answer empty so SDKs stay quiet. */
export function handleStub(req: Request, path: string): Response | null {
  if (path.startsWith('/api/web_experiments')) return json({ experiments: [] }, 200, cors(req));
  if (path.startsWith('/api/early_access_features')) return json({ earlyAccessFeatures: [] }, 200, cors(req));
  return null;
}

/** posthog-js surveys: GET /api/surveys/?token=<project token> -> { surveys: [...] } (protocol.md "Surveys"). */
export async function handleSurveys(req: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get('token') ?? url.searchParams.get('api_key');
  if (!validToken(token)) return json({ type: 'authentication_error', code: 'missing_api_key', detail: 'API key not provided.' }, 401, cors(req));
  const p = await projectByToken(env, token);
  if (!p) return json({ type: 'authentication_error', code: 'invalid_api_key', detail: 'Project API key invalid.' }, 401, cors(req));
  return json({ surveys: await storeFor(env, p.id).activeSurveys() }, 200, { ...cors(req), 'cache-control': 'no-cache' });
}
