# SDK wire format

This is the part of PostHog's public ingestion and flags API that the
posthog-js and posthog-node SDKs use, as this instance must implement it.
It is normative: a build that follows it accepts unmodified SDKs.
`test-vectors.json` holds worked examples. Section references in brackets
point to the PostHog MIT source the rule was read from (commit and paths in
`research.md`); "observed" means seen in recorded SDK traffic.

## 1. Endpoints

| Path (trailing slash optional) | Methods | Used by | Section |
|---|---|---|---|
| `/e`, `/i/v0/e` | POST, GET | posthog-js events (observed: `/e/` before remote config loads, `/i/v0/e/` after) | 2-5 |
| `/batch`, `/capture`, `/track`, `/engage`, `/i/v0/ai/batch` | POST, GET | older SDKs, server SDKs, imports | 2-5 |
| `/i/v1/analytics/events` | POST | posthog-node 6 and other v1 senders | 6 |
| `/flags`, `/decide` | POST, GET | flag evaluation (`/flags/?v=2` from posthog-js, `?v=4` from posthog-node) | 8 |
| `/array/<token>/config`, `/array/<token>/config.js` | GET | posthog-js remote config | 9 |
| `/static/<file>`, `/static/<version>/<file>` | GET | the snippet and lazy-loaded SDK bundles | 9 |
| `/s`, `/i/v0/s` | POST | posthog-js session recorder snapshots (observed: `/s/`) | 11 |
| `/api/surveys` | GET | posthog-js surveys (`?token=`) | 12 |
| `/api/web_experiments`, `/api/early_access_features` | any | out-of-scope products | 9 |
| any of the above | OPTIONS | CORS preflight: 204 | 1 |

Every response to these paths carries
`Access-Control-Max-Age: 86400`,
`Access-Control-Allow-Origin: <request Origin or *>`, and, when an Origin
was sent, `Access-Control-Allow-Credentials: true` and `Vary: Origin`;
preflights also allow `GET, POST, OPTIONS` and echo
`Access-Control-Request-Headers`.

## 2. Legacy capture bodies [rust/capture/src/v0_request.rs]

After decoding (section 4) the body is JSON in one of these shapes:

1. An array of events.
2. An object with `batch` (array of events) and optionally `api_key` or
   `token`, `sent_at` (ISO time) and `historical_migration`.
3. A single event object (has a string `event`).
4. On `/engage` only: an object with `$set` or `$set_once` and no `event`,
   which is treated as one `$identify` event.

Anything else is 400 `invalid_payload`. An empty event list is 400
`empty_batch`. An event is an object with `event` (non-empty string, at most
200 characters), a distinct id (`distinct_id`, or `properties.distinct_id`,
or `$distinct_id`; a string of 1-200 characters, a number is turned into
its string), and optional `uuid`, `timestamp`, `offset` (ms),
`properties`, `$set`, `$set_once`.

`$performance_event`, `$snapshot` and `$snapshot_items` are dropped.

The response is `{"status":1}` with 200, or an empty 204 when the query has
`beacon=1`.

## 3. Project token [rust/capture/src/token.rs]

The token is found, in order, in the body's `api_key` or `token`, the first
event's `api_key`, `token` or `properties.token`, then the query's `token`
or `api_key`. Missing: 401 `no_token`. It is valid when it is 1-64
characters, ASCII, has no NUL byte and does not start with `phx_` (a
personal API key); otherwise 401 `invalid_token`. A valid token that names
no project is accepted with the normal success response and its events are
dropped (PostHog drops them later in its pipeline; SDKs see success).

Error bodies are JSON `{"type", "code", "detail", "attr": null}` where
`type` is `authentication_error` for 401 and `validation_error` otherwise.
SDKs read only the status.

## 4. Body decoding [rust/capture/src/payload/decompression.rs]

Apply these steps in order to the raw request bytes:

1. If the bytes start with the gzip magic `1f 8b`, or `Content-Encoding` is
   `gzip`, gunzip them, whatever the `compression` hint says. (posthog-js
   1.450 sends gzip with `Content-Type: text/plain` and **no**
   `compression` parameter: observed.) A `compression=gzip`/`gzip-js` hint
   on bytes without the magic is ignored (plain text). `Content-Encoding:
   deflate` inflates.
2. Decode as UTF-8 (invalid: 400 `invalid_payload`).
3. If `Content-Type` is `application/x-www-form-urlencoded` or the text
   starts with `data=`, parse it as a form and continue with the `data`
   field; a form `compression` field replaces the query hint.
4. If the hint is `lz64` or `lz-string` and the text does not start with
   `{` or `[`, decompress with LZString `decompressFromBase64`.
5. If the text still does not start with `{` or `[` and is base64 (standard
   or URL alphabet), decode it.
6. Parse JSON (failure: 400 `invalid_payload`).

For GET, the bytes are the `data` query parameter. Decoded bodies over 20 MB
are 413 `payload_too_large`. The query parameter `_` is the client's send
time in ms and is used as `sent_at` when the body has none and it is after
2021-01-01.

## 5. Event normalization

For each event, with `now` the server's receive time:

- **uuid**: kept if it is a UUID (lower-cased), otherwise a new UUIDv7
  from the event time. A uuid already stored for the project is dropped
  (deduplication).
- **Timestamp** [rust/common/types/src/timestamp.rs]:
  1. Parse `timestamp` as RFC 3339 / ISO 8601. A trailing `+HH` or `-HH`
     zone gets `:00` added; a time with no zone is UTC; digits after
     milliseconds are dropped.
  2. If it parsed and `sent_at` is known (and not ignored): event time =
     timestamp − (sent_at − now) (clock-skew correction). If it parsed
     without `sent_at`: the timestamp. Otherwise: `now`.
  3. If `offset` (ms) is present and `now − offset` is a representable date
     (chrono's range, years −262143 to 262142), event time = `now − offset`;
     otherwise the offset is ignored.
  4. More than 23 hours after `now`: use `now`. A year outside 0-9999: the
     Unix epoch.
  `sent_at` is ignored when the event has `properties.$ignore_sent_at:
  true` (legacy) or `options.disable_skew_correction: true` (v1).
- **Person processing**: `options.process_person_profile` (v1) or
  `properties.$process_person_profile` (`false` means no person). Stored
  back on the event as `$process_person_profile`.
- **Person updates**: `$set` and `$set_once` are read from the event's top
  level and from `properties` (top level wins key by key); `$unset` (array
  of names) from `properties`. They are kept on the event in `properties`
  too.
- **v1 fields**: `session_id` and `window_id` become `$session_id` and
  `$window_id` if those are not already set.
- `properties.token` and `properties.distinct_id` are removed.
- **IP and location**: `$ip` is set from `CF-Connecting-IP` unless the event
  has one or the project discards IPs (then `$ip` is removed). Unless the
  event has `$geoip_disable: true` or already carries any `$geoip_*`
  property, Cloudflare's request data adds `$geoip_country_code`,
  `$geoip_country_name`, `$geoip_city_name`, `$geoip_subdivision_1_name`,
  `$geoip_subdivision_1_code`, `$geoip_postal_code`,
  `$geoip_continent_code`, `$geoip_time_zone`, `$geoip_latitude`,
  `$geoip_longitude` (only those present).
- **Library**: when `$lib` is missing and the request has
  `PostHog-Sdk-Info: <lib>/<version>`, set `$lib` and `$lib_version`.

## 6. Capture v1 [rust/capture/src/v1/README.md]

`POST /i/v1/analytics/events`

- `Authorization: Bearer <project token>`. Missing or unparseable header:
  401 `invalid_api_key`; a scheme other than Bearer: 400 `invalid_auth_scheme`; an invalid
  token (section 3): 401.
- `Content-Encoding` absent, `gzip` or `deflate`; anything else is 415
  `unsupported_encoding`.
- Body: `{"created_at": ISO time, "batch": [event…], "capture_internal"?:
  bool, "historical_migration"?: bool}`. Each event: `event`, `uuid`
  (must be a UUID if present, else 400 `invalid_uuid`), `distinct_id`,
  `timestamp`, `properties`, `options` (`process_person_profile`,
  `cookieless_mode`, `disable_skew_correction`, `product_tour_id`),
  `session_id`, `window_id`. `created_at` is the batch's `sent_at`. An
  empty or missing batch, or a body that is not JSON, is 400
  `invalid_payload`.
- `capture_internal: true` sets the event IP to `127.0.0.1`.
- Response 200:
  `{"results": {"<uuid>": {"result": "ok" | "drop", "details"?: string, "duplicates_dropped"?: n}}}`.
  A repeated uuid in the same batch is reported once, with
  `duplicates_dropped`. posthog-node treats any other body as "unreadable
  response" (observed with `{"status":1}`).

| Case | Status | `code` |
|---|---|---|
| empty body, or GET without `data` | 400 | `no_data` |
| empty event list (legacy) | 400 | `empty_batch` |
| body not decodable / not JSON | 400 | `invalid_payload` |
| no token | 401 | `no_token` |
| invalid token | 401 | `invalid_token` (v1: `invalid_api_key`) |
| v1 scheme other than Bearer | 400 | `invalid_auth_scheme` |
| v1 uuid not a UUID | 400 | `invalid_uuid` |
| decoded body over 20 MB | 413 | `payload_too_large` |
| v1 Content-Encoding not gzip/deflate | 415 | `unsupported_encoding` |

## 7. Persons and groups [nodejs/src/ingestion/common/persons, PoE.md]

Processing happens per project, in event order within a delivered batch,
only for events with person processing on (section 5).

- **Merge events.** `$identify` merges `properties.$anon_distinct_id` into
  the event's distinct id; `$create_alias` and `$merge_dangerously` merge
  `properties.alias`. With target = event distinct id and other = that id
  (both legal, different):
  - neither has a person: create one person with both ids, identified;
  - one has a person: add the other id to it, mark it identified;
  - both have the same person: mark it identified;
  - different persons: if the other's person is identified and the event is
    not `$merge_dangerously`, do not merge (mark target identified);
    otherwise move all of the other person's ids to the target person,
    merge properties (target's values win), keep the earlier `created_at`
    and the later `last_seen_at`, delete the other person.
  - `$identify` with no anonymous id: mark the target's person identified,
    creating it if needed.
- **Illegal ids** never take part in a merge: the empty or all-space string;
  case-insensitively `anonymous`, `guest`, `distinctid`, `distinct_id`,
  `id`, `not_authenticated`, `email`, `undefined`, `true`, `false`;
  case-sensitively `[object Object]`, `NaN`, `None`, `none`, `null`, `0`,
  `undefined`; and each of these wrapped in single or double quotes.
- **Properties.** Then, on the target's person (created if missing):
  `$set_once` keys not yet present are set, `$set` keys are set, `$unset`
  keys are removed.
- **Personless events** (`$process_person_profile: false`) create nothing,
  but once their distinct id is linked to a person (for example by a later
  `$identify` with that `$anon_distinct_id`), queries count them for that
  person.
- **Groups.** `$groupidentify` with `$group_type` and `$group_key` creates
  or updates the group, merging `$group_set` into its properties. A project
  has at most 5 group types (indexes 0-4, in first-seen order); more are
  ignored. Group membership of other events is read from their
  `properties.$groups` (`{"company": "acme"}`), which the SDKs add.
  posthog-node sends `$groupidentify` with distinct id
  `$<type>_<key>` and person processing on, so such a person exists, as in
  PostHog.
- Every event updates its person's `last_seen_at`.

## 8. Feature flags [rust/feature-flags/src/flags, properties]

### Request

`POST /flags` (query `v` any value; `config=true` also returns remote
config) or `/decide`. The body is decoded as in section 4 (posthog-js
sends it gzipped as `text/plain`). Fields: `token` (or `api_key`, or the
query), `distinct_id`, `person_properties`, `groups`, `group_properties`,
`flag_keys_to_evaluate`, `$anon_distinct_id`, `$device_id`, `timezone`.
Missing or invalid token, or a token for no project: 401
`{"type":"authentication_error","code":"invalid_api_key",...}`. Undecodable
body: 400 `malformed_data`.

### Evaluation

Properties = the stored properties of the distinct id's person, overlaid by
`person_properties` from the request. Only active flags are evaluated (only
`flag_keys_to_evaluate` when given). For each flag, condition sets in
order:

1. Every property filter in the set must match (below).
2. Rollout: `rollout_percentage` missing or null means 100. 100 matches;
   otherwise `hash(key + ".", distinct_id, "") <= pct / 100`.
3. The first set that matches both decides: enabled, `condition_match`,
   `condition_index` = its index. A set that matched its filters but not
   the rollout leaves `out_of_rollout_bound` as the reason if no later set
   matches; otherwise the reason is `no_condition_match`.
4. Variant (multivariate flags): the set's `variant` override if it names a
   variant; else with `h = hash(key + ".", distinct_id, "variant")`, walk
   the variants in order summing `rollout_percentage / 100` and take the
   first whose running sum is greater than `h`.

`hash(prefix, id, salt)` = take SHA-1 of the UTF-8 string `prefix + id +
salt`, read the first 15 hex digits as an integer and divide by
`0xfffffffffffffff` (vectors `flag_hash`).

Property filters (`{key, value, operator, type}`), with values compared as
their string form (JSON for objects) unless stated:

| operator | matches when |
|---|---|
| `exact` (default) | the value equals, case-insensitively, any of `value` (a list or one value) |
| `is_not` | it equals none of them |
| `icontains` / `not_icontains` | it contains / does not contain `value`, case-insensitively |
| `regex` / `not_regex` | it matches / does not match `value` as a regular expression (an invalid pattern never matches) |
| `gt` `gte` `lt` `lte` | both are numbers (or numeric strings) and compare so; otherwise no match |
| `is_set` / `is_not_set` | the property is present / absent |

A missing property matches only `is_not`, `not_icontains`, `not_regex` and
`is_not_set`.

### Response (200)

```json
{
  "flags": {
    "<key>": {
      "key": "<key>", "enabled": true, "variant": "test",
      "reason": { "code": "condition_match", "condition_index": 0, "description": "Matched condition set 1" },
      "metadata": { "id": 7, "version": 3, "description": "<flag name>", "payload": "{\"color\":\"green\"}" }
    }
  },
  "featureFlags": { "<key>": "test" },
  "featureFlagPayloads": { "<key>": "{\"color\":\"green\"}" },
  "errorsWhileComputingFlags": false,
  "requestId": "<uuid v7>",
  "evaluatedAt": 1795010769773
}
```

- `featureFlags[key]` is the variant, `true`, or `false`.
- Payloads are JSON **strings**: the flag's `payloads[variant]`, or
  `payloads["true"]` for a flag without variants; only for enabled flags.
- `errorsWhileComputingFlags` is true when there was no distinct id.
- `/decide`, and `/flags?config=true`, add the remote config fields of
  section 9 and `config: {"enable_collect_everything": <autocapture on>}`.
- posthog-node 6 asks for `v=4` and accepts this v2-shaped answer (it logs
  an info line once: observed).

## 9. Remote config, SDK files and stubs

`GET /array/<token>/config` (JSON) and `/array/<token>/config.js`
(JavaScript that sets `window._POSTHOG_REMOTE_CONFIG[<token>] = {config:
…, siteApps: []}`), cacheable for 5 minutes; an unknown token is 404.

```json
{
  "token": "<token>", "supportedCompression": ["gzip", "gzip-js"], "hasFeatureFlags": true,
  "analytics": { "endpoint": "/i/v0/e/" }, "elementsChainAsString": true, "defaultIdentifiedOnly": true,
  "autocapture_opt_out": false, "autocaptureExceptions": false, "captureDeadClicks": false,
  "capturePerformance": false, "sessionRecording": false, "heatmaps": false, "surveys": false,
  "productTours": false, "siteApps": []
}
```

`hasFeatureFlags` is whether the project has an active flag.
`autocapture_opt_out` is the project setting. `surveys` is `true` while
the project has a running survey (12). `sessionRecording` is `false`, or,
when the project records sessions, the recorder config posthog-js reads
(fields from posthog-js `packages/browser-common/src/types/remote-config.ts`
`SessionRecordingRemoteConfig`;
observed working with posthog-js 1.450.1):

```json
{ "endpoint": "/s/", "consoleLogRecordingEnabled": true, "recorderVersion": "v2", "sampleRate": null,
  "minimumDurationMilliseconds": null, "linkedFlag": null, "networkPayloadCapture": null, "masking": null,
  "urlTriggers": [], "urlBlocklist": [], "eventTriggers": [], "triggerMatchType": null, "scriptConfig": null }
```

The `/flags` response with `config=true` (and `/decide`) carries the same
two fields.

`/static/<file>` serves the posthog-js `dist/*.js` files of the version the
build installed (plus its licence), with CORS and a one-hour cache;
`/static/<version>/<file>` serves the same file for any version (posthog-js
asks for `/static/<its version>/surveys.js` first: observed). posthog-js
loads extension bundles such as `surveys.js` even when the remote config
turns the product off, so every bundle must be present.

Stubs: `/api/web_experiments` → `{"experiments":[]}`,
`/api/early_access_features` → `{"earlyAccessFeatures":[]}`.

## 10. SDK behaviour to expect (informative, observed)

- posthog-js drops all events from user agents it classifies as bots,
  including headless Chrome, unless `opt_out_useragent_filter: true`.
  Tests that drive a headless browser must set it.
- posthog-js loads `config.js`, then sends events (batched, gzip,
  `text/plain`) to `/e/` until remote config arrives and to the config's
  `analytics.endpoint` (`/i/v0/e/`) after.
- `$identify` events carry `$set` and `$set_once` at the **top level** and
  `properties.$anon_distinct_id`; `people.set` sends a `$set` event with
  `properties.$set`; `group()` sends `$groupidentify` and adds `$groups`
  to later events; `alias()` sends `$create_alias` with
  `properties.alias`.
- With `person_profiles: 'identified_only'` (the default), events before
  `identify()` have `$process_person_profile: false`.
- Autocapture sends `$elements_chain` as a string. `$pageleave` on
  navigation is sent with `fetch(…, {keepalive: true})`, not
  `sendBeacon`.
- posthog-node 6 posts v1 batches (gzip, `application/json`) and calls
  `/flags/?v=4`.

## 11. Session recording snapshots [posthog-js packages/browser/src/extensions/replay; observed]

posthog-js loads the recorder from `/static/<version>/lazy-recorder.js`
(`scriptConfig.script` would rename it; this instance sends `null`) once
remote config has a `sessionRecording` object, then POSTs batches to the
config's `endpoint` (`/s/`). Observed with posthog-js 1.450.1: gzip body,
`Content-Type: text/plain`, no query string; decode as section 4.

The body is a JSON array of events (a `{"batch": [...]}` object or a single
event is also accepted):

```json
[{ "uuid": "01a1ef4e-…", "event": "$snapshot", "timestamp": "2026-…Z",
   "properties": { "$snapshot_data": [ <rrweb event>, … ], "$snapshot_bytes": 27654,
     "$session_id": "01a1ef4e-98a2-…", "$window_id": "01a1ef4e-98a2-…", "distinct_id": "user-42",
     "token": "<project token>", "$lib": "web", "$lib_version": "1.450.1", "$snapshot_host": "…" } }]
```

- The token is `properties.token` (else the body's `api_key`/`token`, else
  `?token=`). `$snapshot_items` is accepted as an older name for
  `$snapshot_data`. Events other than `$snapshot`/`$snapshot_items` are
  ignored. `$session_id` must match `[A-Za-z0-9._:-]{1,200}`.
- The answer is always `{"status":1}` (200) once the body decodes, also
  when the project does not record sessions (the data is dropped); a body
  that does not decode is 400 `invalid_payload`, over 20 MB 413.
- rrweb events are `{type, data, timestamp}`: 2 full snapshot, 3
  incremental (`data.source`: 0 mutation, 1 mouse move, 2 mouse
  interaction where `data.type` 2 is a click, 3 scroll, 5 input, 8
  stylesheet rule), 4 meta (`data.href`, `width`, `height`), 5 custom
  (posthog-js sends `$remote_config_received`, `$session_options`,
  `$posthog_config`, `$recording_started`, and `$pageview` on navigation), 6
  plugin (`rrweb/console@1` with `payload.level`).
- **Field compression** (observed on every full snapshot and mutation):
  an event with `"cv": "2024-10"` carries some fields as a string whose
  characters are the bytes (0-255) of a gzip stream of the field's JSON:
  `data` of a type 2 event; `texts`, `attributes`, `removes` and `adds` of
  a type 3 source 0 event; `adds` and `removes` of a type 3 source 8 event.
  Fields that are already arrays or objects are left as they are. A reader
  gunzips them, parses the JSON and drops `cv`.
- Inputs are masked by posthog-js before sending (observed: `"text":
  "*******"` for a password and for text fields); the server stores what it
  receives.
- Regular events carry `$session_id` and `$window_id`, which link them to
  the recording.

## 12. Surveys [posthog-js packages/browser-common/src/types/surveys.ts, packages/core/src/surveys/events.ts; observed]

posthog-js fetches `GET /api/surveys/?token=<token>&_=<ms>` (observed)
when remote config says `surveys: true`, and lazy-loads
`/static/<version>/surveys.js`. A missing or malformed token is 401
`missing_api_key`, an unknown one 401 `invalid_api_key`. The answer:

```json
{ "surveys": [ { "id": "<uuid>", "name": "NPS", "description": "", "type": "popover",
  "questions": [
    { "id": "q-rating", "type": "rating", "question": "How likely…?", "description": "", "optional": false,
      "display": "number", "scale": 10, "lowerBoundLabel": "Unlikely", "upperBoundLabel": "Very likely" },
    { "id": "q-choice", "type": "single_choice", "question": "What brought you here?", "choices": ["Search", "Friend", "Ad"],
      "hasOpenChoice": false, "shuffleOptions": false },
    { "id": "q-open", "type": "open", "question": "Anything else?" } ],
  "appearance": { "whiteLabel": true }, "conditions": { "events": { "values": [ { "name": "opened_pricing" } ] } },
  "start_date": "2026-…Z", "end_date": null, "linked_flag_key": null, "targeting_flag_key": null,
  "internal_targeting_flag_key": null, "feature_flag_keys": [], "current_iteration": null,
  "current_iteration_start_date": null, "schedule": "once", "enable_partial_responses": false } ] }
```

Only running surveys (launched, not stopped, not archived) are listed;
posthog-js itself applies `conditions` (`url` with `urlMatchType`,
`selector`, `events`, `deviceTypes`) and remembers per browser which
surveys it showed. `appearance.whiteLabel: true` hides posthog-js's
"Survey by PostHog" footer.

Events posthog-js sends (observed), on the normal capture path:

- `survey shown`: `$survey_id`, `$survey_name`, `$survey_iteration`,
  `$survey_iteration_start_date`.
- `survey dismissed`: the same, plus `$survey_partially_completed` when
  some questions were answered.
- `survey sent`: the same, plus `$survey_submission_id` (one id per
  person's pass through the survey), `$survey_completed`,
  `$survey_questions` (`[{id, question, response}]`) and one
  `$survey_response_<question id>` per answer (a number for ratings, a
  string for single choice and open, an array for multiple choice), and a
  top-level `$set: {"$survey_responded/<survey id>": true}`. Older SDKs
  send `$survey_response` for the first question and
  `$survey_response_<index>` for later ones; readers accept both.

## 13. Experiment exposure [observed]

`posthog.getFeatureFlag(key)` and `isFeatureEnabled(key)` send
`$feature_flag_called` the first time a flag is read in a page load (and
again if its value changes), with `$feature_flag` (the key),
`$feature_flag_response` (variant string or boolean), `$feature_flag_id`,
`$feature_flag_version`, `$feature_flag_reason`, `$feature_flag_request_id`,
`$feature_flag_payload` and `$feature_flag_bootstrapped_response`
(observed). posthog-node's `getFeatureFlag` / `evaluateFlags().getFlag`
sends the same event from the server. Experiments use the first such
event per person as the exposure (design.md "Experiments").
