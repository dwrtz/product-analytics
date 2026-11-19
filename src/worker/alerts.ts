// Alert delivery (design.md "Alerts"): every alert is kept in the project store (shown in the app); when the instance
// has a Cloudflare Email Sending binding (EMAIL) and a sender address (ALERT_EMAIL_FROM), it is also emailed.
import type { Env } from './env';
import { origin } from './env';

export type AlertKind = 'usage_threshold' | 'usage_spike' | 'error_new' | 'error_regression' | 'test';
export type Alert = { id?: number; kind: AlertKind; title: string; body: string; link: string | null; created_at?: number };

export const emailConfigured = (env: Env) => !!(env.EMAIL && env.ALERT_EMAIL_FROM && /@/.test(env.ALERT_EMAIL_FROM));
/** Where alerts go: the project's alert_emails, else every user of the instance. */
export async function recipients(env: Env, configured: string[]): Promise<string[]> {
  if (configured.length) return configured;
  return (await env.DB.prepare('SELECT email FROM users ORDER BY id').all<{ email: string }>()).results.map(r => r.email);
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

/** Sends one alert; returns a short status for the alert row ("sent to 2", "off", or the error code). */
export async function emailAlert(env: Env, projectName: string, a: Alert, to: string[], appName = 'Product Analytics'): Promise<string> {
  if (!emailConfigured(env)) return 'off';
  if (!to.length) return 'no recipients';
  const url = a.link ? origin(env) + a.link : origin(env);
  const subject = `[${projectName}] ${a.title}`.slice(0, 200);
  const text = `${a.title}\n\n${a.body}\n\nOpen: ${url}\n\n— ${appName} alerts for ${projectName}. Change recipients in the project's settings.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="font-size:18px">${esc(a.title)}</h2><p style="white-space:pre-wrap">${esc(a.body)}</p>` +
    `<p><a href="${esc(url)}">Open in ${esc(appName)}</a></p><p style="color:#666;font-size:12px">${esc(appName)} alerts for ${esc(projectName)}. Change recipients in the project's settings.</p></div>`;
  let ok = 0; const errors: string[] = [];
  for (const rcpt of to.slice(0, 20)) {
    try { await env.EMAIL!.send({ from: env.ALERT_EMAIL_FROM!, to: rcpt, subject, text, html }); ok++; }
    catch (e) { const code = (e as any)?.code ?? (e instanceof Error ? e.message : String(e)); errors.push(String(code).slice(0, 120)); }
  }
  return errors.length ? `sent to ${ok}, failed ${errors.length}: ${errors[0]}` : `sent to ${ok}`;
}
