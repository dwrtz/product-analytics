// SDK-facing endpoints besides capture: /flags, /decide, remote config, and stubs for products out of scope (spec R4, R5).
import { Env, ProjectRow, json, storeFor } from './env';
import { cors } from './capture';
import { decodeBody } from '../shared/decode';
import { projectByToken, validToken } from './projects';
import { uuidv7 } from '../shared/ids';

export function remoteConfig(p: ProjectRow, hasFlags: boolean) {
  return {
    token: p.api_token, supportedCompression: ['gzip', 'gzip-js'], hasFeatureFlags: hasFlags,
    analytics: { endpoint: '/i/v0/e/' }, elementsChainAsString: true, defaultIdentifiedOnly: true,
    autocapture_opt_out: !!p.autocapture_opt_out, autocaptureExceptions: false, captureDeadClicks: false, capturePerformance: false,
    sessionRecording: false, heatmaps: false, surveys: false, productTours: false, siteApps: [],
  };
}

export async function handleConfig(req: Request, env: Env, token: string, js: boolean): Promise<Response> {
  const p = validToken(token) ? await projectByToken(env, token) : null;
  if (!p) return js ? new Response('/* unknown project */', { status: 404, headers: { 'content-type': 'application/javascript', ...cors(req) } }) : json({ type: 'authentication_error', code: 'invalid_api_key', detail: 'Unknown project token.' }, 404, cors(req));
  const cfg = remoteConfig(p, await storeFor(env, p.id).hasActiveFlags());
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
  const flags = typeof did === 'string' && did ? await store.evaluateFlags(did, (body.person_properties && typeof body.person_properties === 'object') ? body.person_properties : {}, Array.isArray(body.flag_keys_to_evaluate) ? body.flag_keys_to_evaluate.map(String) : null) : [];
  const featureFlags: Record<string, string | boolean> = {}; const featureFlagPayloads: Record<string, string> = {}; const byKey: Record<string, unknown> = {};
  for (const f of flags) {
    byKey[f.key] = f;
    featureFlags[f.key] = f.enabled ? (f.variant ?? true) : false;
    if (f.enabled && f.metadata.payload !== null) featureFlagPayloads[f.key] = f.metadata.payload;
  }
  const out: Record<string, unknown> = { flags: byKey, featureFlags, featureFlagPayloads, errorsWhileComputingFlags: typeof did !== 'string' || !did, requestId: uuidv7(), evaluatedAt: Date.now() };
  if (legacyDecide || url.searchParams.get('config') === 'true') Object.assign(out, remoteConfig(p, flags.length > 0), { config: { enable_collect_everything: !p.autocapture_opt_out } });
  return json(out, 200, cors(req));
}

/** Endpoints for products this build does not have: answer empty so SDKs stay quiet. */
export function handleStub(req: Request, path: string): Response | null {
  if (path.startsWith('/api/surveys')) return json({ surveys: [] }, 200, cors(req));
  if (path.startsWith('/api/web_experiments')) return json({ experiments: [] }, 200, cors(req));
  if (path.startsWith('/api/early_access_features')) return json({ earlyAccessFeatures: [] }, 200, cors(req));
  if (path === '/s' || path === '/s/' || path.startsWith('/i/v0/s')) return json({ status: 1 }, 200, cors(req));
  return null;
}
