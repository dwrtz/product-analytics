// UUIDs and random tokens.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
/** UUIDv7 (time-ordered). */
export function uuidv7(ms = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const t = BigInt(ms);
  for (let i = 0; i < 6; i++) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function randomToken(prefix: string, n = 43): string {
  const r = crypto.getRandomValues(new Uint8Array(n)); let s = prefix;
  for (const x of r) s += B62[x % 62];
  return s;
}
/** distinct ids that never merge persons (protocol.md "Persons"). */
const CI = ['anonymous', 'guest', 'distinctid', 'distinct_id', 'id', 'not_authenticated', 'email', 'undefined', 'true', 'false'];
const CS = ['[object Object]', 'NaN', 'None', 'none', 'null', '0', 'undefined'];
const quoted = (a: string[]) => a.flatMap(x => [x, `'${x}'`, `"${x}"`]);
const CI_SET = new Set(quoted(CI)); const CS_SET = new Set(quoted(CS));
export const isIllegalDistinctId = (id: string) => id.trim() === '' || CI_SET.has(id.toLowerCase()) || CS_SET.has(id);
