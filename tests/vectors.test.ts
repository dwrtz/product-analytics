// Unit tests driven by spec/test-vectors.json (protocol.md).
import { describe, it, expect } from 'vitest';
import V from '../spec/test-vectors.json';
import { parseDate, parseEventTimestamp } from '../src/shared/timestamp';
import { flagHash, matchProperty, evaluateFlag } from '../src/shared/flags';
import { isIllegalDistinctId } from '../src/shared/ids';
import { decodeBody, DecodeError } from '../src/shared/decode';
import { validToken } from '../src/worker/projects';
import { resolveRange, buckets, startOf } from '../src/shared/dates';

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

describe('timestamps (protocol.md 5)', () => {
  const now = parseDate(V.timestamps.now)!;
  for (const c of V.timestamps.cases as any[]) it(c.name, () => {
    const { ts } = parseEventTimestamp(c.timestamp, c.offset, c.sent_at ? parseDate(c.sent_at) : null, !!c.ignore_sent_at, now);
    expect(iso(ts)).toBe(c.expect);
  });
});

describe('project tokens (protocol.md 3)', () => {
  it('accepts valid tokens', () => { for (const t of V.tokens.valid) expect(validToken(t), t).toBe(true); });
  it('rejects invalid tokens', () => { for (const t of V.tokens.invalid) expect(validToken(t.token), t.reason).toBe(false); });
});

describe('feature flag hashing (protocol.md 8)', () => {
  for (const c of V.flag_hash.cases) it(`${c.prefix}${c.id}`, async () => expect(await flagHash(c.prefix, c.id, c.salt)).toBe(c.hash));
  it('variants follow PostHog test_variants', async () => {
    for (const [id, variant] of Object.entries(V.flag_hash.variants.expect)) {
      const r = await evaluateFlag(V.flag_hash.variants.flag as any, id, {});
      expect(r.variant, id).toBe(variant);
      expect(r.reason.code).toBe('condition_match');
    }
  });
  it('0% and 100% rollout', async () => {
    for (const c of V.flag_hash.rollout) {
      const r = await evaluateFlag({ id: 9, key: 'f', active: true, version: 1, filters: { groups: [{ properties: [], rollout_percentage: c.rollout_percentage }] } }, c.distinct_id, {});
      expect(r.enabled).toBe(c.enabled); expect(r.reason.code).toBe(c.reason);
    }
  });
  it('person property conditions and payloads', async () => {
    const flag = { id: 3, key: 'pro', active: true, version: 2, filters: { groups: [{ properties: [{ key: 'plan', value: ['pro'], operator: 'exact', type: 'person' }], rollout_percentage: 100 }], payloads: { true: '{"a":1}' } } };
    const yes = await evaluateFlag(flag, 'x', { plan: 'Pro' });
    expect(yes).toMatchObject({ enabled: true, variant: null, reason: { code: 'condition_match', condition_index: 0 }, metadata: { id: 3, version: 2, payload: '{"a":1}' } });
    const no = await evaluateFlag(flag, 'x', {});
    expect(no).toMatchObject({ enabled: false, reason: { code: 'no_condition_match' }, metadata: { payload: null } });
  });
});

describe('property matching (protocol.md 8)', () => {
  for (const c of V.property_match.cases as any[]) it(`${c.filter.operator} ${JSON.stringify(c.filter.value ?? '')} on ${JSON.stringify(c.props)}`, () => expect(matchProperty(c.filter, c.props)).toBe(c.match));
});

describe('illegal distinct ids (protocol.md 7)', () => {
  it('never merge', () => { for (const id of V.illegal_distinct_ids.never_merge) expect(isIllegalDistinctId(id), JSON.stringify(id)).toBe(true); });
  it('allowed', () => { for (const id of V.illegal_distinct_ids.allowed) expect(isIllegalDistinctId(id), id).toBe(false); });
});

describe('request bodies (protocol.md 4)', () => {
  for (const c of V.bodies.cases as any[]) it(c.name, async () => {
    const q = new URLSearchParams(c.query ?? '');
    const text = await decodeBody(unb64(c.body_base64), { compression: q.get('compression'), contentType: c.content_type, contentEncoding: c.content_encoding });
    expect(JSON.parse(text)).toEqual(JSON.parse(V.bodies.json));
  });
  it('rejects broken gzip', async () => {
    await expect(decodeBody(new Uint8Array([0x1f, 0x8b, 1, 2, 3]), {})).rejects.toBeInstanceOf(DecodeError);
  });
});

describe('date ranges and buckets (design.md Queries)', () => {
  const now = Date.parse('2026-03-10T10:30:00Z');
  it('-7d starts at local midnight 7 days back', () => {
    const r = resolveRange('-7d', null, 'Asia/Kolkata', now);
    expect(new Date(r.from).toISOString()).toBe('2026-03-02T18:30:00.000Z');
    expect(r.to).toBe(now);
  });
  it('day buckets across a DST change stay at local midnight', () => {
    const r = resolveRange('2026-03-07', '2026-03-09', 'America/New_York', now);
    const b = buckets(r, 'day', 'America/New_York');
    expect(b.map(x => x.label)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(b[1].end - b[1].start).toBe(23 * 3600_000);
  });
  it('weeks start on Sunday', () => {
    expect(new Date(startOf(Date.parse('2026-03-11T12:00:00Z'), 'week', 'UTC')).toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });
});
