import fs from 'node:fs'; import zlib from 'node:zlib'; import LZ from 'lz-string';
const body = JSON.stringify({ api_key: 'phc_vectortoken', sent_at: '2026-11-18T12:00:00.000Z', batch: [{ event: '$pageview', properties: { distinct_id: 'd1', $current_url: 'https://example.com/' }, timestamp: '2026-11-18T11:59:59.000Z' }] });
const b64 = (b) => Buffer.from(b).toString('base64');
const V = {
  about: 'Worked examples for protocol.md. Sources are PostHog MIT code paths (rust/capture, rust/common/types, rust/feature-flags, nodejs persons) at posthog commit 0f73d659, or runtime captures of posthog-js 1.450.1 and posthog-node 6.0.3. Times are ms since the Unix epoch unless an ISO string is shown.',
  timestamps: {
    source: 'rust/common/types/src/timestamp.rs tests',
    now: '2023-01-01T12:00:00Z',
    cases: [
      { name: 'client clock ahead by 10s', timestamp: '2023-01-01T11:00:00Z', sent_at: '2023-01-01T12:00:10Z', expect: '2023-01-01T10:59:50Z' },
      { name: 'client clock behind by 10s', timestamp: '2023-01-01T11:00:00Z', sent_at: '2023-01-01T11:59:50Z', expect: '2023-01-01T11:00:10Z' },
      { name: 'clocks aligned', timestamp: '2023-01-01T11:00:00Z', sent_at: '2023-01-01T12:00:00Z', expect: '2023-01-01T11:00:00Z' },
      { name: 'no sent_at: timestamp as sent', timestamp: '2023-01-01T11:00:00Z', expect: '2023-01-01T11:00:00Z' },
      { name: 'ignore_sent_at', timestamp: '2023-01-01T11:00:00Z', sent_at: '2023-01-01T12:00:10Z', ignore_sent_at: true, expect: '2023-01-01T11:00:00Z' },
      { name: 'nothing: now', expect: '2023-01-01T12:00:00Z' },
      { name: 'sent_at alone: now', sent_at: '2023-01-01T12:00:10Z', expect: '2023-01-01T12:00:00Z' },
      { name: 'offset wins', timestamp: '2023-01-01T11:00:00Z', sent_at: '2023-01-01T12:00:10Z', offset: 5000, expect: '2023-01-01T11:59:55Z' },
      { name: 'unparseable timestamp: now', timestamp: 'not a date', expect: '2023-01-01T12:00:00Z' },
      { name: 'offset out of range is ignored (no timestamp)', offset: -8300000000000000, expect: '2023-01-01T12:00:00Z' },
      { name: 'offset out of range is ignored (timestamp kept)', timestamp: '2023-01-01T11:00:00Z', offset: 9007199254740991, expect: '2023-01-01T11:00:00Z' },
      { name: 'more than 23h in the future: now', timestamp: '2023-01-03T12:00:00Z', expect: '2023-01-01T12:00:00Z' },
      { name: '22h in the future is kept', timestamp: '2023-01-02T10:00:00Z', expect: '2023-01-02T10:00:00Z' },
      { name: '+HH zone gets :00', timestamp: '2023-01-01T14:00:00.000+03', expect: '2023-01-01T11:00:00Z' },
      { name: 'zone-less time is UTC', timestamp: '2023-01-01T11:00:00', expect: '2023-01-01T11:00:00Z' },
    ],
  },
  tokens: {
    source: 'rust/capture/src/token.rs',
    valid: ['phc_abc123', 'a', 'x'.repeat(64), 'with space'],
    invalid: [{ token: '', reason: 'empty' }, { token: 'x'.repeat(65), reason: 'too_long' }, { token: 'phc_é', reason: 'not_ascii' }, { token: 'phx_personalkey', reason: 'personal_api_key' }, { token: 'a\u0000b', reason: 'null_byte' }],
  },
  flag_hash: {
    source: 'rust/feature-flags/src/flags/flag_matching_utils.rs (calculate_hash) and test_flag_matching.rs',
    rule: 'SHA-1 of prefix + identifier + salt; first 15 hex digits as an integer / 0xfffffffffffffff',
    cases: [
      { prefix: 'holdout-', id: 'some_distinct_id', salt: '', hash: 0.7270002403585725 },
      { prefix: 'holdout-', id: 'test-identifier', salt: '', hash: 0.4493881716040236 },
      { prefix: 'holdout-', id: 'example_id', salt: '', hash: 0.9402003475831224 },
      { prefix: 'holdout-', id: 'example_id2', salt: '', hash: 0.6292740389966519 },
    ],
    variants: {
      flag: { id: 1, key: 'beta-feature', version: 1, active: true, filters: { groups: [{ properties: [], rollout_percentage: null }], multivariate: { variants: [{ key: 'first-variant', rollout_percentage: 50 }, { key: 'second-variant', rollout_percentage: 25 }, { key: 'third-variant', rollout_percentage: 25 }] } } },
      expect: { '11': 'first-variant', example_id: 'second-variant', '3': 'third-variant' },
    },
    rollout: [
      { rollout_percentage: 0, distinct_id: 'test_user', enabled: false, reason: 'out_of_rollout_bound' },
      { rollout_percentage: 100, distinct_id: 'test_user', enabled: true, reason: 'condition_match' },
    ],
  },
  property_match: {
    source: 'rust/feature-flags/src/properties/property_matching.rs',
    cases: [
      { filter: { key: 'email', value: 'A@Example.com', operator: 'exact' }, props: { email: 'a@example.com' }, match: true },
      { filter: { key: 'plan', value: ['pro', 'team'], operator: 'exact' }, props: { plan: 'team' }, match: true },
      { filter: { key: 'plan', value: ['pro'], operator: 'exact' }, props: {}, match: false },
      { filter: { key: 'plan', value: ['pro'], operator: 'is_not' }, props: {}, match: true },
      { filter: { key: 'plan', value: ['pro'], operator: 'is_not' }, props: { plan: 'pro' }, match: false },
      { filter: { key: 'n', value: 5, operator: 'exact' }, props: { n: '5' }, match: true },
      { filter: { key: 'flag', value: 'true', operator: 'exact' }, props: { flag: true }, match: true },
      { filter: { key: 'email', value: 'EXAMPLE', operator: 'icontains' }, props: { email: 'a@example.com' }, match: true },
      { filter: { key: 'email', value: 'example', operator: 'not_icontains' }, props: { email: 'a@example.com' }, match: false },
      { filter: { key: 'email', value: '@example\\.com$', operator: 'regex' }, props: { email: 'a@example.com' }, match: true },
      { filter: { key: 'age', value: 18, operator: 'gt' }, props: { age: 21 }, match: true },
      { filter: { key: 'age', value: '18', operator: 'lte' }, props: { age: '18' }, match: true },
      { filter: { key: 'age', value: 18, operator: 'gt' }, props: { age: 'old' }, match: false },
      { filter: { key: 'email', operator: 'is_set' }, props: { email: 'x' }, match: true },
      { filter: { key: 'email', operator: 'is_not_set' }, props: {}, match: true },
    ],
  },
  illegal_distinct_ids: {
    source: 'nodejs/src/common/persons/person-utils.ts',
    never_merge: ['anonymous', 'Guest', 'DISTINCT_ID', 'distinctid', 'id', 'not_authenticated', 'email', 'undefined', 'true', 'False', '[object Object]', 'NaN', 'None', 'none', 'null', '0', '"null"', "'undefined'", '', '   '],
    allowed: ['NULL', 'nan', 'user-1', 'u@example.com', '00'],
  },
  bodies: {
    source: 'rust/capture/src/payload (decompression.rs, types.rs) and posthog-js 1.450.1 runtime capture',
    json: body,
    cases: [
      { name: 'plain JSON', content_type: 'application/json', body_base64: b64(body) },
      { name: 'gzip with no hint (posthog-js 1.450 default: text/plain, no compression param)', content_type: 'text/plain', body_base64: b64(zlib.gzipSync(body)) },
      { name: 'gzip-js hint', query: 'compression=gzip-js', content_type: 'text/plain', body_base64: b64(zlib.gzipSync(body)) },
      { name: 'Content-Encoding gzip (posthog-node v1)', content_encoding: 'gzip', content_type: 'application/json', body_base64: b64(zlib.gzipSync(body)) },
      { name: 'lz64 hint', query: 'compression=lz64', content_type: 'application/x-www-form-urlencoded', body_base64: b64('data=' + encodeURIComponent(LZ.compressToBase64(body))) },
      { name: 'form data= base64', content_type: 'application/x-www-form-urlencoded', body_base64: b64('data=' + encodeURIComponent(Buffer.from(body).toString('base64'))) },
      { name: 'raw base64 body', content_type: 'text/plain', body_base64: b64(Buffer.from(body).toString('base64')) },
    ],
  },
  capture_responses: {
    legacy: { status: 200, body: { status: 1 }, beacon: { query: 'beacon=1', status: 204 } },
    v1: { status: 200, body: { results: { '01890000-0000-7000-8000-000000000001': { result: 'ok' } } } },
    errors: [
      { path: '/e/', body: '{"batch":[]}', status: 400, code: 'empty_batch', note: 'empty batch' },
      { path: '/e/', body: '{"batch":[{"event":"x","distinct_id":"d"}]}', status: 401, type: 'authentication_error', code: 'no_token', note: 'no token' },
      { path: '/e/', body: '{"api_key":"phx_abc","batch":[{"event":"x","distinct_id":"d"}]}', status: 401, type: 'authentication_error', code: 'invalid_token', note: 'personal key as project token' },
      { path: '/i/v1/analytics/events', headers: {}, status: 401, note: 'missing Authorization' },
      { path: '/i/v1/analytics/events', headers: { authorization: 'Basic abc' }, status: 400, note: 'not Bearer' },
      { path: '/i/v1/analytics/events', headers: { authorization: 'Bearer phx_x' }, status: 401, note: 'personal key' },
      { path: '/i/v1/analytics/events', headers: { authorization: 'Bearer phc_x', 'content-encoding': 'br' }, status: 415, note: 'unsupported encoding' },
    ],
  },
  persons: {
    source: 'nodejs/src/ingestion/common/persons (identify / alias / merge)',
    scenarios: [
      { name: 'identify links the anonymous id', events: [{ event: '$pageview', distinct_id: 'anon-1', properties: { $process_person_profile: false } }, { event: '$identify', distinct_id: 'user-1', properties: { $anon_distinct_id: 'anon-1' }, $set: { email: 'u@example.com' } }], expect: { persons: [{ distinct_ids: ['anon-1', 'user-1'], properties: { email: 'u@example.com' }, is_identified: true }], events_by_person: { 'user-1': 2 } } },
      { name: 'alias joins two ids', events: [{ event: '$set', distinct_id: 'a', properties: { $set: { x: 1 } } }, { event: '$create_alias', distinct_id: 'a', properties: { alias: 'b' } }], expect: { persons: [{ distinct_ids: ['a', 'b'], properties: { x: 1 }, is_identified: true }] } },
      { name: 'identify never merges two identified persons', events: [{ event: '$identify', distinct_id: 'u1', properties: {} }, { event: '$identify', distinct_id: 'u2', properties: {} }, { event: '$identify', distinct_id: 'u2', properties: { $anon_distinct_id: 'u1' } }], expect: { persons: [{ distinct_ids: ['u1'] }, { distinct_ids: ['u2'] }] } },
      { name: '$merge_dangerously merges identified persons', events: [{ event: '$identify', distinct_id: 'u1', properties: {}, $set: { a: 1, b: 1 } }, { event: '$identify', distinct_id: 'u2', properties: {}, $set: { b: 2 } }, { event: '$merge_dangerously', distinct_id: 'u2', properties: { alias: 'u1' } }], expect: { persons: [{ distinct_ids: ['u1', 'u2'], properties: { a: 1, b: 2 } }] } },
      { name: 'illegal id does not merge', events: [{ event: '$identify', distinct_id: 'user-9', properties: { $anon_distinct_id: 'null' } }], expect: { persons: [{ distinct_ids: ['user-9'] }] } },
      { name: '$set_once keeps the first value, $unset removes', events: [{ event: '$set', distinct_id: 'p', properties: { $set_once: { first: 'a' }, $set: { k: 1 } } }, { event: '$set', distinct_id: 'p', properties: { $set_once: { first: 'b' }, $unset: ['k'] } }], expect: { persons: [{ distinct_ids: ['p'], properties: { first: 'a' } }] } },
    ],
  },
};
fs.writeFileSync(process.argv[2], JSON.stringify(V, null, 1) + '\n');
