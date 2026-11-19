// Deterministic sampling (design.md "Usage limits"): the same key always gets the same answer, at the edge and in the
// project store, so a person or a session is either kept whole or dropped whole.
/** FNV-1a 32-bit hash of the key scaled to [0, 1). */
export function hashUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 4294967296;
}
/** True when the key is inside the sample; rate 1 keeps everything, 0 keeps nothing. */
export const sampled = (key: string, rate: number): boolean => rate >= 1 || (rate > 0 && hashUnit(key) < rate);
