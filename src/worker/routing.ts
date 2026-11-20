// Web-app fallback for unmatched GETs (spec R13, design.md "Routing").
/** Paths that are never the web app: SDK endpoints, the owner API, static files and health. */
const NOT_APP = /^\/(api|static|i|s|e|batch|capture|track|engage|flags|decide|array|_health)(\/|$)/;
/**
 * Unmatched GET and HEAD requests serve the web app (it routes on the client) unless the caller explicitly asks for JSON:
 * an Accept with application/json and neither text/html nor * / *. So browsers, curl and uptime probes get 200 at `/`.
 */
export function wantsApp(method: string, path: string, accept: string | null): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (NOT_APP.test(path) || /\.[a-z0-9]{1,8}$/i.test(path)) return false;
  const a = (accept ?? '').toLowerCase();
  if (a.includes('application/json') && !a.includes('text/html') && !a.includes('*/*')) return false;
  return true;
}

