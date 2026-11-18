// Request body decoding for the capture endpoints (protocol.md "Bodies"). Pure; Web APIs only.
import LZString from 'lz-string';

export class DecodeError extends Error { constructor(public code: string, msg?: string) { super(msg ?? code); } }
export const MAX_DECODED = 20 * 1024 * 1024;

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const B64_RE = /^[A-Za-z0-9+/\-_]+={0,2}$/;

async function inflate(b: Uint8Array, format: 'gzip' | 'deflate'): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  const stream = new Blob([b as unknown as ArrayBuffer]).stream().pipeThrough(ds);
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.length; if (n > MAX_DECODED) { await reader.cancel(); throw new DecodeError('payload_too_large'); }
      parts.push(value);
    }
  } catch (e) { if (e instanceof DecodeError) throw e; throw new DecodeError('invalid_gzip'); }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function b64decode(s: string): string {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(u);
}
const looksJson = (s: string) => /^\s*[[{]/.test(s);

/** Normalizes a compression hint: gzip | lz64 | base64 | null. */
export function compressionHint(v: string | null | undefined): 'gzip' | 'lz64' | 'base64' | null {
  switch ((v ?? '').toLowerCase()) {
    case 'gzip': case 'gzip-js': return 'gzip';
    case 'lz64': case 'lz-string': return 'lz64';
    case 'base64': case 'b64': return 'base64';
    default: return null;
  }
}

/**
 * Turns raw request bytes into the JSON text of the payload.
 * Order: gzip magic bytes (whatever the hint) or gzip hint; Content-Encoding; lz64 hint;
 * form body `data=` (+ form `compression=`); base64 unwrap when the text is not JSON.
 */
export async function decodeBody(bytes: Uint8Array, opts: { compression?: string | null; contentType?: string | null; contentEncoding?: string | null }): Promise<string> {
  let hint = compressionHint(opts.compression);
  const ce = (opts.contentEncoding ?? '').toLowerCase().trim();
  if (isGzip(bytes) || hint === 'gzip' || ce === 'gzip') {
    if (!isGzip(bytes) && hint === 'gzip' && ce !== 'gzip') {
      // Hint says gzip but no magic: some clients send gzip-js and fall back to plain text.
    } else {
      bytes = await inflate(bytes, 'gzip'); hint = null;
    }
  } else if (ce === 'deflate') { bytes = await inflate(bytes, 'deflate'); }
  if (bytes.length > MAX_DECODED) throw new DecodeError('payload_too_large');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); } catch { throw new DecodeError('invalid_utf8'); }
  if ((opts.contentType ?? '').toLowerCase().includes('application/x-www-form-urlencoded') || /^data=/.test(text)) {
    const form = new URLSearchParams(text);
    const d = form.get('data');
    if (d !== null) { text = d; hint = compressionHint(form.get('compression')) ?? hint; }
  }
  if (hint === 'lz64' && !looksJson(text)) {
    const out = LZString.decompressFromBase64(text.trim());
    if (!out) throw new DecodeError('invalid_lz64');
    text = out;
  }
  if (!looksJson(text) && B64_RE.test(text.trim())) {
    try { const d = b64decode(text); if (looksJson(d)) text = d; } catch { /* not base64 */ }
  }
  if (text.length > MAX_DECODED) throw new DecodeError('payload_too_large');
  return text;
}
