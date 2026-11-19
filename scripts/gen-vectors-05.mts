// Adds the 0.5 sections (sampling, quota_limited, source_maps, fingerprints) to spec/test-vectors.json after gen-vectors.mjs.
// Run from the repo root: npx esbuild scripts/gen-vectors-05.mts --bundle --platform=node --format=esm --outfile=.gen05.mjs && node .gen05.mjs
import fs from 'node:fs';
import { hashUnit, sampled } from '../src/shared/sample.ts';
import { decodeMap, originalPosition } from '../src/shared/sourcemap.ts';
import { fingerprintOf, normalizeFilename, normalizeMessage } from '../src/worker/errors.ts';
const F = JSON.parse(fs.readFileSync('tests/fixtures/v05-errors.json', 'utf8'));
const path = 'spec/test-vectors.json';
const V = JSON.parse(fs.readFileSync(path, 'utf8'));
const keys = ['cap:user-1', 'cap:user-2', 'ac:01a1f3c5-9768-7ecc-ae2f-7589c52b2fcf', 'cap:sess-a', ''];
V.sampling = { source: 'design.md "Usage limits": FNV-1a 32-bit over the UTF-16 code units of the key, divided by 2^32; kept when below the rate. Keys: cap:<distinct_id> (events past a cap), cap:<session_id> (replay past a cap), ac:<$session_id or distinct_id> (autocapture).',
  cases: keys.map(k => ({ key: k, unit: hashUnit(k), kept_at_0_5: sampled(k, 0.5), kept_at_0_25: sampled(k, 0.25) })) };
V.quota_limited = { source: 'posthog-js 1.450.1 src/rate-limiter.ts (MIT): a capture response whose JSON has quota_limited: [batch keys] pauses those keys for 60 s. Batch keys: events (default), exceptionEvent, recordings.',
  capture_capped_drop: { status: 1, quota_limited: ['events', 'exceptionEvent'] }, snapshots_capped_drop: { status: 1, quota_limited: ['recordings'] },
  v1_capped_drop_has: { quota_limited: ['events', 'exceptionEvent'] }, sample_mode: { status: 1 } };
const map = decodeMap(F.app_min_js_map);
V.source_maps = { source: 'Source Map Revision 3 (tc39.es/ecma426); map and frames from tests/fixtures/v05-errors.json (esbuild bundle, posthog-js frames). Lines and columns are 1-based like stack traces.',
  map: F.app_min_js_map, positions: [[1, 49], [1, 159], [1, 206], [1, 358], [1, 275]].map(([l, c]) => ({ line: l, column: c, expect: originalPosition(map, l, c) })) };
const list = F.posthog_js_exceptions.map((e: any) => e.properties);
V.fingerprints = { source: 'design.md "Error tracking": $exception_fingerprint wins (custom:<value>); else SHA-256 (first 16 bytes, hex) of "<type>\\n" + top five in-app frames innermost first as "<function>@<normalized filename>" joined by \\n; with no frames "<type>\\n<normalized message>".',
  cases: [
    { name: 'posthog-js unhandled TypeError (raw frames)', properties: list[0], expect: await fingerprintOf(list[0], list[0].$exception_list) },
    { name: 'posthog-js unhandled rejection', properties: list[1], expect: await fingerprintOf(list[1], list[1].$exception_list) },
    { name: 'custom fingerprint', properties: list[3], expect: await fingerprintOf(list[3], list[3].$exception_list) },
    { name: 'no frames: type and normalized message', properties: { $exception_list: [{ type: 'Error', value: 'Order 1234 failed for "bob"' }] }, expect: await fingerprintOf({}, [{ type: 'Error', value: 'Order 1234 failed for "bob"' }]) },
    { name: 'same as above with other numbers and strings', properties: { $exception_list: [{ type: 'Error', value: 'Order 99 failed for "ann"' }] }, expect: await fingerprintOf({}, [{ type: 'Error', value: 'Order 99 failed for "ann"' }]) },
  ],
  filenames: ['https://cdn.test/assets/app.3f9a2c1b.js?v=2', '/assets/index-B7xQ2kLp.js', '/js/app-facade.js', 'node:internal/modules/run_main'].map(f => ({ filename: f, expect: normalizeFilename(f) })),
  messages: ['Profile 42 not found for "bob"', 'Bad id 0x1F at 3.5s for 0190f3c2-1111-7000-8000-000000000000'].map(m => ({ message: m, expect: normalizeMessage(m) })) };
fs.writeFileSync(path, JSON.stringify(V, null, 1) + '\n');
console.log(JSON.stringify(V.sampling.cases), V.fingerprints.cases.map((c: any) => c.expect));
