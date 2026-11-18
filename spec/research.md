# Research notes

This spec describes an independent product-analytics service that speaks
the public wire protocol of PostHog's SDKs, so the published `posthog-js` (Apache-2.0 and MIT) and
`posthog-node` libraries work against it unchanged. It contains no PostHog
code and no PostHog branding. This file records how the protocol was
established, the evidence behind each rule, what is still unknown, and the
0.1 choices. It is context, not extra requirements.

## Method: REA (reverse engineer anything)

REA was installed from its official source only: the npm package
`rea-agents` 6.9.0 (MIT; repository `github.com/morluto/rea`), with its
bundled `reverse-engineer-anything` skill. Its method was followed:

1. **Collect evidence, not impressions.** Every observation is an evidence
   record with a content-addressed id (`ev_<sha256>`), its parameters, and
   the tool's own stated limitations and unknowns.
2. **Static analysis** of the shipped artifact (`analyze_javascript_application`
   on the `posthog-js` 1.450.1 npm package).
3. **Runtime capture** of the real SDK in a real browser
   (`capture_browser_scenario`): a scripted page that loads the snippet,
   captures, identifies, groups, sets properties, aliases, reads a flag,
   navigates and resets, with request and response bodies recorded.
4. **Read the reference source** (the MIT `posthog-foss` mirror) for the
   server-side rules the SDK traffic cannot show: validation, timestamps,
   person merges, flag hashing, funnel semantics.
5. **Write down obligations** (what a server must do), each tied to its
   evidence, and list what stays unknown.
6. **Conformance:** replay the same browser scenario against the self-built
   server and require every SDK request to succeed.

### What REA contributed

- The static pass over the minified bundle gave an inventory (476 files
  examined) but little protocol detail: routes and payloads are built
  dynamically, and REA reported them as unresolved (its limitation list says
  so). It did confirm the set of lazily loaded extension bundles.
- The runtime captures established what the code does not make obvious:
  - posthog-js 1.450 sends event batches **gzip-compressed with
    `Content-Type: text/plain` and no `compression` query parameter**, so a
    server must sniff the gzip magic bytes;
  - it posts to `/e/` until remote config loads and then to the config's
    `analytics.endpoint` (`/i/v0/e/`);
  - flags go to `/flags/?v=2&config=true` with a gzipped body;
  - it fetches `/array/<token>/config.js` and then
    `/static/<version>/surveys.js` **even when surveys are off**, so every
    extension bundle must be served (the first conformance run caught four
    404s here, fixed before the second);
  - it drops all events from headless browsers unless
    `opt_out_useragent_filter` is set (no request at all was the evidence);
  - `$identify` puts `$set`/`$set_once` at the event's top level;
  - `$pageleave` uses `fetch` with `keepalive`, not `sendBeacon`.
- A small recording server (`recorder/`) logged posthog-js and posthog-node
  traffic byte for byte (`sdk-wire.recorded.jsonl`,
  `node-sdk-wire.recorded.jsonl`): posthog-node 6 posts **v1** batches to
  `/i/v1/analytics/events` (Bearer token, gzip JSON) and treats a
  `{"status":1}` answer as unreadable, and calls `/flags/?v=4`.
- The final conformance capture against the self-built server: 16 SDK
  transactions, all 2xx, none failed.

## Evidence ledger

Evidence files are kept with the reference build's working notes
(not part of the published spec).

| Evidence id | Operation | What |
|---|---|---|
| `ev_85e84d97…` (summary `ev_964c577b…`) | analyze_javascript_application | posthog-js 1.450.1 npm package, static |
| `ev_fc227d71…` (summary `ev_6a20c49e…`) | capture_browser_scenario | posthog-js against the recorder (port 8799), first run |
| `ev_1bf4f557…` (summary `ev_5b4d3a36…`) | capture_browser_scenario | same, with identify/group/alias/flag steps; 2 expected failures (recorder has no flag or survey answers) |
| `ev_69c9eef3…` (summary `ev_c588dca9…`) | capture_browser_scenario | posthog-js against the self-built server: 18 transactions, 4 failed (`surveys.js` 404) |
| `ev_d91bc8d5…` (summary `ev_f5fb4a24…`) | capture_browser_scenario | the same after the fix: 16 transactions, 0 failed |
| `sdk-wire.recorded.jsonl` | recorder | raw posthog-js requests (headers, bodies) |
| `node-sdk-wire.recorded.jsonl` | recorder | raw posthog-node 6.0.3 requests |

Full ids are in the `*.summary.yaml` and `*.evidence.json` files.

## Obligation ledger

Source paths are in `PostHog/posthog-foss` at commit `0f73d659`
(2026-11-18, MIT) and `PostHog/posthog-js` at `15aef2ce` (npm package licence `Apache-2.0 AND MIT`).

| Rule (`protocol.md` section) | Source |
|---|---|
| Legacy body shapes, dropped events (2) | `rust/capture/src/v0_request.rs` |
| Token rule (3) | `rust/capture/src/token.rs` |
| Error codes (3, 6) | `rust/capture/src/api.rs` |
| Decoding order, gzip sniffing (4) | `rust/capture/src/payload/decompression.rs`; runtime captures |
| Timestamps, skew, offset, future cutoff (5) | `rust/common/types/src/timestamp.rs` and its tests |
| v1 request and response (6) | `rust/capture/src/v1/README.md`, `rust/capture/src/v1/analytics/*`; node recording |
| Illegal distinct ids (7) | `nodejs/src/common/persons/person-utils.ts`, `rust/capture/src/v1/analytics/constants.rs` |
| Merge rules, identified flag (7) | `nodejs/src/ingestion/common/persons/PoE.md`, `person-merge-*.ts` |
| Flag hash, rollout, variants (8) | `rust/feature-flags/src/flags/flag_matching.rs`, `flag_matching_utils.rs`, `test_flag_matching.rs` (the variant vectors are PostHog's own test values) |
| Property operators (8) | `rust/feature-flags/src/properties/` |
| Flags response shape (8) | `rust/feature-flags/src/flags/flag_match_reason.rs`, `api/`; runtime captures |
| Remote config fields (9) | runtime captures (`config.js`), posthog-js `packages/browser/src/remote-config.ts` |
| Lazy bundles (9) | runtime captures `ev_69c9eef3…` / `ev_d91bc8d5…` |
| Ordered funnel semantics | `funnel-udf/src/steps.rs` |
| Funnel events limited to the date range | `products/product_analytics/backend/hogql_queries/funnels/funnel_event_query.py` |

## Unknowns and deliberate differences

- **Same-timestamp funnel events.** PostHog's funnel query has extra
  handling for events that share a timestamp; this build takes them in
  storage order. Results can differ only when two steps' events share a
  millisecond. Not verified against PostHog.
- **Error bodies.** PostHog capture answers errors in plain text; this
  build sends JSON with the same status and a `code`. SDKs read only the
  status. Unknown whether any third-party client parses the text.
- **Unknown project token** is accepted and dropped (as PostHog's capture
  service does at the edge); `/flags` answers 401 for it (as PostHog does).
- **No `regex` in insight filters** (SQLite has no regex function by
  default); flags do support it.
- **Exact matching** is case-insensitive in flags (as PostHog's flag
  service) and case-sensitive in insight filters (as PostHog's queries).
- **No local evaluation endpoint**, so posthog-node evaluates flags
  remotely (it falls back on its own; observed).
- **`/flags?v=4`** gets the v2-shaped answer; posthog-node 6 accepts it.
  The full v4 differences were not studied.
- **Personless events** are counted for a person once their distinct id is
  linked (query-time join); PostHog's exact backfill behaviour was not
  verified beyond its documentation.
- **Geo** comes from Cloudflare's request data instead of a MaxMind
  lookup, so `$geoip_*` values follow Cloudflare's naming.
- Not studied: session replay, surveys, experiments, heatmaps, web
  analytics, the data warehouse, HogQL.

## Licensing

- PostHog's `posthog-foss` repository is MIT; `posthog-js` is published
  as `Apache-2.0 AND MIT`. Only those
  were read; nothing under `ee/` or any other commercially licensed path
  was opened or used.
- The spec states behaviour in its own words; no PostHog source is copied.
  Test vectors were computed by the reference build and checked against
  PostHog's MIT test values where they exist.
- The build ships the unmodified `posthog-js` `dist` files and its
  `LICENSE` (as `posthog-js.LICENSE.txt`) under `/static/`, as its
  licences allow.
- The product name, UI and copy are neutral. "PostHog" appears only where
  the protocol is attributed (here and in `protocol.md`).

## Choices made for 0.1

- One Durable Object per project instead of Analytics Engine or Basin
  (`design.md`, "Storage"). Basin is the planned path past 10 GB per
  project.
- One team per instance; sign-up limited to the first account or
  `ALLOWED_EMAILS`.
- IPs stored by default (as PostHog); per-project "Discard client IP
  addresses".
- Events kept forever by default (as self-hosted PostHog); a deployer can
  set `DEFAULT_RETENTION_DAYS` for new projects, and owners change it per
  project. The daily cron purges when set.
