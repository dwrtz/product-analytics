// Accounts, sessions and personal API keys (spec R2).
import { Env, HttpError, nowIso, isoIn, UserRow, origin } from './env';
import { randomToken } from '../shared/ids';

const te = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
export const sha256hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');
const ITER = 100_000;
async function pbkdf2(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITER }, key, 256));
}
const eq = (a: Uint8Array, b: Uint8Array) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };

/**
 * Everyone signed in sees every project (one team per instance), so sign-up is narrow:
 * with ALLOWED_EMAILS set, only those addresses; without it, only the very first account.
 */
export async function signupOpen(env: Env, email?: string): Promise<boolean> {
  if ((env.ALLOWED_EMAILS ?? '').trim()) return email === undefined || allowedEmail(env, email);
  return !(await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first());
}
export function allowedEmail(env: Env, email: string) {
  const list = (env.ALLOWED_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(email.trim().toLowerCase());
}
export const COOKIE = 'pa_session';
const cookie = (token: string, maxAge: number, env: Env) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin(env).startsWith('https:') ? '; Secure' : ''}`;
async function newSession(env: Env, userId: number) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256hex(token), userId, isoIn(30 * 86400)).run();
  return cookie(token, 30 * 86400, env);
}

export async function signup(env: Env, body: any) {
  const email = String(body?.email ?? '').trim();
  const password = String(body?.password ?? '');
  const name = String(body?.name ?? '').trim().slice(0, 80) || email.split('@')[0];
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'bad_request', 'Enter a valid email.');
  if (!allowedEmail(env, email)) throw new HttpError(403, 'email_not_allowed', 'This instance is private.');
  if (!await signupOpen(env, email)) throw new HttpError(403, 'signup_closed', 'Sign-up is closed on this instance.');
  if (password.length < 10) throw new HttpError(400, 'bad_request', 'Password must be at least 10 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  const r = await env.DB.prepare('INSERT OR IGNORE INTO users (email, name, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(email, name, b64(hash), b64(salt), nowIso()).first<{ id: number }>();
  if (!r) throw new HttpError(409, 'taken', 'That email already has an account.');
  return { userId: r.id, cookie: await newSession(env, r.id) };
}
export async function login(env: Env, body: any) {
  const email = String(body?.email ?? '').trim();
  const password = String(body?.password ?? '');
  if (!allowedEmail(env, email)) throw new HttpError(403, 'email_not_allowed', 'This instance is private.');
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
  const hash = await pbkdf2(password, u ? unb64(u.pw_salt) : new Uint8Array(16));
  if (!u || !eq(hash, unb64(u.pw_hash))) throw new HttpError(401, 'bad_credentials', 'Wrong email or password.');
  return { userId: u.id, cookie: await newSession(env, u.id) };
}
const readCookie = (req: Request) => new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`).exec(req.headers.get('cookie') ?? '')?.[1] ?? null;
export async function logout(env: Env, req: Request) {
  const t = readCookie(req);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(t)).run();
  return cookie('', 0, env);
}
/** Signed-in user from the session cookie or a personal API key (Authorization: Bearer phx_...). */
export async function authenticate(env: Env, req: Request): Promise<{ user: UserRow; via: 'session' | 'key' } | null> {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const h = await sha256hex(auth.slice(7).trim());
    const k = await env.DB.prepare('SELECT id, user_id FROM personal_api_keys WHERE key_hash = ?').bind(h).first<{ id: number; user_id: number }>();
    if (!k) return null;
    await env.DB.prepare('UPDATE personal_api_keys SET last_used_at = ? WHERE id = ?').bind(nowIso(), k.id).run();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(k.user_id).first<UserRow>();
    return user && allowedEmail(env, user.email) ? { user, via: 'key' } : null;
  }
  const c = readCookie(req); if (!c) return null;
  const s = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await sha256hex(c), nowIso()).first<{ user_id: number }>();
  if (!s) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(s.user_id).first<UserRow>();
  return user && allowedEmail(env, user.email) ? { user, via: 'session' } : null;
}
export async function createPersonalKey(env: Env, userId: number, label: string) {
  const key = randomToken('phx_', 43);
  await env.DB.prepare('INSERT INTO personal_api_keys (user_id, label, key_hash, mask, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, (label || 'API key').slice(0, 60), await sha256hex(key), `phx_...${key.slice(-4)}`, nowIso()).run();
  return key;
}
