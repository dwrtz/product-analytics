// Session replay over HTTP (design.md "Session replay"): the recorder's real /s/ requests (captured with REA) are stored in
// R2, summarized through the queue, listed, and served back decompressed for rrweb-player.
import { describe, it, expect, vi } from 'vitest';
import { exports } from 'cloudflare:workers';
import F from './fixtures/snapshot-requests.json';
import { decompressEvent, summarize } from '../src/worker/replay';

const SITE = 'http://app.test';
const W = (exports as any).default;
const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.cookie) h.set('cookie', init.cookie);
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && path.startsWith('/api/')) h.set('origin', SITE);
  return W.fetch(new Request(SITE + path, { ...init, headers: h })) as Promise<Response>;
};
const gzip = async (s: string) => new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
async function owner() {
  const body = JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' });
  let r = await call('/api/signup', { method: 'POST', body });
  if (r.status !== 201) r = await call('/api/login', { method: 'POST', body });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const p = await (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Replay', timezone: 'UTC' }), cookie })).json() as any;
  return { cookie, p };
}
const withToken = (req: any[], token: string) => req.map(e => ({ ...e, properties: { ...e.properties, token } }));
const SID = (F.requests[0] as any)[0].properties.$session_id;

describe('session replay', () => {
  it('summarizes rrweb events', () => {
    const items = (F.requests[0] as any[]).flatMap(e => e.properties.$snapshot_data);
    const s = summarize(items);
    expect(s).toMatchObject({ clicks: 9, keypresses: 4, url: 'http://localhost:8798/' });
  });
  it('remote config turns the recorder on per project', async () => {
    const { cookie, p } = await owner();
    expect(((await (await call(`/array/${p.api_token}/config`)).json()) as any).sessionRecording).toBe(false);
    await call(`/api/projects/${p.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ session_recording: true }) });
    const c = await (await call(`/array/${p.api_token}/config`)).json() as any; // PATCH clears the token cache
    expect(c.sessionRecording).toMatchObject({ endpoint: '/s/', recorderVersion: 'v2' });
  });
  it('stores the recorder requests and serves decompressed snapshots', async () => {
    const { cookie, p } = await owner();
    await call(`/api/projects/${p.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ session_recording: true }) });
    for (const req of F.requests as any[]) {
      const r = await call('/s/?compression=gzip-js', { method: 'POST', body: await gzip(JSON.stringify(withToken(req, p.api_token))), headers: { 'content-type': 'text/plain' } });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ status: 1 });
    }
    let list: any;
    await vi.waitFor(async () => {
      list = await (await call(`/api/projects/${p.id}/session_recordings`, { cookie })).json();
      expect(list.results[0]?.chunks).toBe(2);
    }, { timeout: 8000, interval: 200 });
    expect(list.results[0]).toMatchObject({ id: SID, distinct_id: 'user-42', click_count: 10, keypress_count: 4, start_url: 'http://localhost:8798/', recording_duration: 10 });
    const snaps = (await (await call(`/api/projects/${p.id}/session_recordings/${SID}/snapshots`, { cookie })).json() as any).snapshots;
    expect(snaps.length).toBe(72);
    expect(snaps.some((e: any) => 'cv' in e)).toBe(false);
    const full = snaps.find((e: any) => e.type === 2);
    expect(full.data.node.type).toBe(0); // rrweb Document node
    const mutation = snaps.find((e: any) => e.type === 3 && e.data.source === 0);
    expect(Array.isArray(mutation.data.adds)).toBe(true);
    expect(snaps.every((e: any, i: number) => i === 0 || e.timestamp >= snaps[i - 1].timestamp)).toBe(true);
    expect(snaps[0].windowId).toBeTruthy();
    // Delete removes the metadata and the R2 chunks.
    expect((await call(`/api/projects/${p.id}/session_recordings/${SID}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await call(`/api/projects/${p.id}/session_recordings/${SID}`, { cookie })).status).toBe(404);
  });
  it('drops snapshots for projects with recording off', async () => {
    const { cookie, p } = await owner();
    await call('/s/', { method: 'POST', body: JSON.stringify(withToken(F.requests[1] as any, p.api_token)) });
    await new Promise(r => setTimeout(r, 500));
    expect((await (await call(`/api/projects/${p.id}/session_recordings`, { cookie })).json() as any).results).toEqual([]);
  });
  it('leaves events without the cv marker alone', async () => {
    const e = { type: 3, timestamp: 1, data: { source: 0, adds: [] } };
    expect(await decompressEvent(e)).toBe(e);
  });
});
