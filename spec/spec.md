# Product Analytics

## What this builds

A self-hosted product analytics service on Cloudflare Workers that the
PostHog SDKs can send to unchanged. A site adds the usual posthog-js
snippet with `api_host` set to this instance (or a server uses posthog-node
with `host` set to it), and events, identified people, groups and feature
flags work as they do against PostHog Cloud. The owner signs in to a small
web app to explore events and people, build trends, funnels and retention
insights, pin them to dashboards, manage feature flags, watch session
recordings, run A/B experiments on multivariate flags and run surveys that
posthog-js shows to visitors.

Every deploy is one *instance* on one domain. An instance holds one or more
*projects*; each project has a public *project API key* (`phc_…`) that SDKs
send with every request. Everyone who can sign in to an instance sees all of
its projects (one team per instance).

The design keeps PostHog's wire format exactly and replaces its storage:
the capture endpoint checks and normalizes events and puts them on a
Cloudflare Queue; the queue consumer hands them to the project's *head*
SQLite-backed Durable Object, which processes persons and groups and writes
each event into an *event shard*: one more SQLite Durable Object per project
and calendar month (UTC). The head holds the project's people, groups,
saved insights, dashboards, flags, experiments, surveys and recording
metadata; queries fan out to the shards a date range touches and are
finished in the head, exactly. Session recording chunks live in R2. D1
holds only instance data (users, sessions, keys, projects).

This is not PostHog and uses no PostHog code. The wire format and the
analytics semantics were reconstructed from PostHog's MIT-licensed code and
from recorded SDK traffic (`research.md`); nothing comes from PostHog's
`ee/` directory or other commercially licensed code, and no PostHog name,
logo or artwork is used in the product. The SDKs (posthog-js, MIT and
Apache-2.0; posthog-node, MIT) are used as published, unmodified.

Read `spekkr.inputs.json` first: `app_name` is the product name in the web
app, `brand_color` its accent colour. `protocol.md` is the normative SDK
wire format, with `test-vectors.json` to prove it. `design.md` has the
storage design, Cloudflare config, data model, query semantics, owner API,
screens, tests and deploy steps. `tasks.md` is the build order.
`research.md` records how the protocol was established and what is still
unknown; it is context, not extra requirements.

## Names and words

- **Working name.** The slug is `product-analytics` and the display name
  "Product Analytics". To rename, change only the slug in `spekkr.json`
  (`id`, `name`) and `wrangler.example.jsonc` (`name`, `database_name`,
  queue names, which are always `<slug>`, `<slug>-ingest` and
  `<slug>-ingest-dlq`). The app's shown name is the `app_name` setting, and
  no code depends on the slug (`design.md` shows the default).

- The product is called `app_name` everywhere in the web app. The SDKs keep
  their own names; the web app may say "posthog-js" and "posthog-node" when
  it tells the owner how to install them, and nothing else uses the PostHog
  name.
- Events and properties keep the SDKs' names (`$pageview`, `$identify`,
  `$current_url`, …). The UI may show friendly labels for the common ones
  ("Pageview", "Identify").
- Text the spec quotes is the text to use. Other UI text is the builder's
  own, short and plain. Icons are inline SVG or text; no images or fonts are
  copied from anywhere.

## Out of scope for 0.2

- Heatmaps, web experiments, product tours, early access features, error
  tracking, logs, LLM analytics, data warehouse, CDP destinations,
  notebooks and actions. The SDK endpoints for these answer "nothing
  configured" (`protocol.md` 9) so the SDKs stay quiet.
- Replay: network payload capture, canvas recording, recording triggers
  (URL, event or linked-flag triggers, sampling, minimum duration),
  playlists, comments and a recordings filter UI beyond person and date.
- Experiments: holdouts, secondary metric dashboards over time, sample
  size calculator, experience continuity across identify, frequentist
  statistics, group-aggregated experiments, web (no-code) experiments.
- Surveys: targeting flags and internal targeting flags (posthog-js's own
  once-per-person memory still applies), iterations/schedules, translations,
  branching logic editor (stored and served if sent through the API),
  widget and hosted (external) survey pages, survey templates.
- HogQL / SQL editor, cohorts, lifecycle, stickiness and paths insights,
  group analytics screens (groups are stored and usable in maths and
  filters, but there is no groups list), funnel trends and time-to-convert
  views.
- Feature flag local evaluation (`/api/feature_flag/local_evaluation`),
  cohort and flag-dependency conditions, group-aggregated flags,
  experience continuity, encrypted payloads, remote config flags.
- Per-project permissions, organizations, invitations, SSO, billing.
- Ingestion transformations, plugins, webhooks, GeoIP lookups beyond what
  Cloudflare puts on the request.

## Requirements

Each requirement has an id. Tests name the id they cover.

### R1. Run and store

- One Cloudflare Worker, TypeScript, Web APIs only (no `node:*` modules, no
  `nodejs_compat`). It serves the capture and SDK endpoints, the owner API
  and the web app (from a generated module, not Assets; rrweb-player is a
  second generated module served as `/player.js` and `/player.css`). An
  Assets binding serves only `/static/*`: the posthog-js browser bundles,
  copied from the
  npm package at build time.
- Bindings: D1 `DB`; Durable Object namespaces `STORE` (class
  `ProjectStore`) and `SHARDS` (class `EventShard`), both SQLite storage;
  R2 bucket `REPLAY` (recording chunks); Queue `INGEST` (producer and
  consumer on the same Worker, with a dead-letter queue); Assets `ASSETS`.
  Vars `SITE_URL`, `ALLOWED_EMAILS`, `DEFAULT_RETENTION_DAYS` and
  `REPLAY_RETENTION_DAYS` (`SHARD_PERIOD` exists for tests only). No
  secrets. A daily cron trigger applies data retention. Exact config in
  `design.md`; no domain, account id or resource id is hard-coded anywhere.
- `npm run dev` builds, applies local D1 migrations and runs `wrangler dev`
  on port 8787. `npm test` runs the Vitest suites inside the Workers
  runtime. `npm run e2e` runs the end-to-end test against a running
  instance (R14).

Check: `npm run dev` serves the web app on port 8787 and
`GET /_health` answers `{"ok":true}`.

### R2. Accounts and access

- Email and password accounts. Passwords are at least 10 characters,
  stored as PBKDF2-SHA256 (100,000 iterations, 16-byte random salt).
  Sessions are random 32-byte tokens in an `HttpOnly; SameSite=Lax` cookie
  `pa_session` (plus `Secure` when `SITE_URL` is https), stored as SHA-256,
  30 days.
- Because every account sees every project, sign-up is narrow: with
  `ALLOWED_EMAILS` (comma-separated, case-insensitive) set, only those
  emails can sign up, sign in or keep a session (others get 403
  `{"error":"email_not_allowed"}`); with it empty, only the first account
  can be created and later sign-ups get 403 `{"error":"signup_closed"}`.
  `GET /api/config` reports `signup_open`.
- Personal API keys (`phx_` + 43 base62 characters) act as their owner when
  sent as `Authorization: Bearer phx_…` to `/api/*`. They are shown once,
  stored as SHA-256 with a display mask, and can be revoked.
- Every state-changing `/api/*` request authenticated by cookie must carry
  an `Origin` equal to `SITE_URL` (else 403 `bad_origin`).

Check: the first sign-up succeeds and a second is refused with
`signup_closed`; a cookie POST with a foreign Origin is 403; a personal key
lists projects and a wrong key is 401.

### R3. Capture endpoints

- `POST` (and `GET ?data=`) on `/e`, `/batch`, `/capture`, `/track`,
  `/engage`, `/i/v0/e` and `/i/v0/ai/batch`, each with or without a
  trailing slash, accept every body encoding and shape in `protocol.md`
  sections 2-4 and answer `{"status":1}` (204 with `beacon=1`).
- `POST /i/v1/analytics/events` accepts the batch format of
  `protocol.md` section 6 (Bearer project token, gzip or deflate) and
  answers a per-event results map.
- Errors use the statuses and codes in `protocol.md` section 6 (400, 401,
  413, 415). An unknown but well-formed project token is accepted and the
  events dropped, as PostHog does.
- Accepted events are normalized (`protocol.md` 5) and put on `INGEST`;
  a single event too big for a queue message goes straight to the store.
- CORS: preflight `OPTIONS` answers 204; responses reflect the request
  Origin.

Check: every body vector in `test-vectors.json` is accepted; the error
vectors give their status and code; a v1 batch answers
`{"results":{"<uuid>":{"result":"ok"}}}`.

### R4. Feature flags for SDKs

- `/flags` (any `v`) and the legacy `/decide` evaluate the project's active
  flags for the request's `distinct_id` with the stored person properties
  overlaid by `person_properties` from the request (`protocol.md` 8), and
  answer the v2 `flags` object together with the v1 `featureFlags` and
  `featureFlagPayloads` maps, so every SDK version reads it.
- Hashing, rollout, variant selection and property matching follow
  `protocol.md` 8 exactly, so a person gets the same variant as on PostHog.

Check: the `flag_hash` and `property_match` vectors pass; posthog-js reads
a person-property flag right after `identify()` and gets a variant and its
payload; posthog-node evaluates a flag.

### R5. Remote config and the SDK files

- `GET /array/<token>/config` and `/array/<token>/config.js` answer the
  remote config in `protocol.md` 9: `sessionRecording` is the recorder
  config when the project records sessions (else `false`), `surveys` is
  `true` while the project has a running survey, autocapture follows the
  project setting, and heatmaps and the other out-of-scope products are off.
- `GET /static/<file>` and `/static/<version>/<file>` serve the posthog-js
  bundles (`array.js`, `array.full.js`, the lazy extensions such as
  `surveys.js`) with CORS, so the standard snippet loads from the instance.
- The stub endpoints in `protocol.md` 9 answer empty results.

Check: the snippet from the Settings screen, pasted into a page on another
origin, loads `array.js` from the instance and sends events with no failed
requests.

### R6. Persons and groups

- Person processing follows `protocol.md` 7: `$identify`, `$create_alias`
  and `$merge_dangerously` link or merge distinct ids; `$set`, `$set_once`
  and `$unset` (top level or in properties) update person properties;
  illegal distinct ids never merge; events with
  `$process_person_profile: false` create no person.
- Queries join events to persons through the distinct-id table at query
  time, so events sent before `identify()` count for the identified person.
- `$groupidentify` creates or updates a group (`$group_type`, `$group_key`,
  `$group_set`); at most 5 group types per project. Events carry their
  groups in `$groups`.
- Events with the same `uuid` are stored once, and their person updates
  are applied once (R15).

Check: the `persons` scenarios in `test-vectors.json` give the expected
persons; in the e2e, the anonymous pageview and the identified one belong
to the same person.

### R7. Events explorer

- Newest events first, 100 per page with a cursor; filter by event name and
  by event or person property filters (`design.md`, "Property filters").
  Each row shows event, person (or distinct id), URL or library and time;
  opening a row shows all properties.

Check: the e2e finds `$pageview`, `$autocapture`, `$identify`,
`$groupidentify`, `$pageleave` and the custom events it sent.

### R8. People

- Persons list (newest first, search by email, name or distinct id, with a
  total), person page (properties, distinct ids, first and last seen,
  recent events, their recordings) and "Delete person and events" (which
  also deletes their recordings).

Check: searching the identified email finds one person with both distinct
ids.

### R9. Insights

- Trends, funnels and retention, with the query shapes and the exact maths
  in `design.md` ("Queries"): series with total, unique persons, unique
  sessions, unique groups and property sum, average, min, max, median and
  percentiles; hour, day, week and month intervals in the project's time
  zone (weeks start on Sunday); breakdown by an event or person property
  with a limit and "Other"; compare to the previous period; line, bar,
  number, total-value bars and table displays; ordered and unordered
  funnels with a conversion window, conversion times and breakdown;
  recurring and first-time retention by day, week or month.
- Insights are saved with a name and the query, listed, edited and deleted.

Check: the store tests' hand-computed dataset gives the expected trends,
funnel and retention numbers, including one person whose anonymous and
identified events are counted once.

### R10. Dashboards

- Dashboards hold saved insights as tiles, can override the date range for
  all tiles, can be pinned, and render each tile with its insight's display.

Check: a dashboard with a trend, a number, a funnel, breakdown bars and a
retention table renders them all (`shots/dashboard.png`).

### R11. Feature flags (owner)

- Create, edit, enable or disable and delete flags: key, description,
  condition sets (person property filters and a rollout percentage each),
  optional variants with percentages that add up to 100, and optional JSON
  payloads per variant (or one for "enabled"). Each save bumps the flag's
  version.

Check: invalid variant percentages or payload JSON are refused with 400.

### R12. Projects and retention

- Projects have a name, a time zone (IANA), a data retention in days (0
  keeps everything), "Discard client IP addresses", "Turn off
  autocapture" and "Record sessions" (off by default). The project API key
  can be reset. Deleting a project deletes its store, its event shards and
  its recordings.
- A new project's retention is the `retention_days` sent when it is
  created, else the instance var `DEFAULT_RETENTION_DAYS`; empty or `0`
  means forever (as self-hosted PostHog). Deployers choose; owners can
  change it per project in Settings.
- The daily cron deletes events older than each project's retention
  (whole shards at a time where it can) and recordings older than
  `REPLAY_RETENTION_DAYS` (default 30) or the project's retention, whichever
  is shorter.

Check: the store test purges events before a cutoff; deleting a project
makes its token unknown; with `DEFAULT_RETENTION_DAYS` set, a new project
gets it and an explicit `retention_days: 0` overrides it.

### R13. Web app

Signed-in screens (layout in `design.md`): Dashboards, Dashboard, Insights,
Insight editor (trends, funnel, retention), Events (with a replay link per
event that has a `$session_id`), Persons, Person (with recordings), Session
replay list, Recording (player and the session's events), Feature flags,
Flag editor, Experiments, New experiment, Experiment (results), Surveys,
Survey editor, Survey (results), Settings (install snippet, project API
key, project settings, other projects, danger zone) and Account (personal
API keys, sign out). Usable on a phone (390 px wide).

Check: the screenshots in `shots/` are taken from the reference build.

### R14. Quality

- Unit tests cover every vector in `test-vectors.json`; store tests check
  person processing and insight maths on a fixed dataset; shard tests check
  that day shards, month shards and legacy data answer every query kind
  identically; HTTP tests cover accounts, capture, flags, remote config,
  replay (with recorded posthog-js `/s/` bodies), surveys (with recorded
  survey events) and experiments (statistics checked against a closed
  form). `npm test` passes.
- The e2e (`npm run e2e`) loads the real posthog-js snippet in Chromium on
  a separate origin and drives capture, identify, group, flags, a session
  recording and a survey popover, sends posthog-node events, aliases and a
  flag call, then checks stored events, merged persons, insight numbers,
  the recording (decompressed, password masked), survey results,
  experiment exposures and the UI screens, including the replay player.
- Logs never contain project tokens, personal keys, session tokens,
  passwords or event bodies. `tsc --noEmit` passes for the Worker and UI.

### R15. Event shards (more events)

- Events are stored in `EventShard` Durable Objects, one per project and
  UTC calendar month (`design.md`, "Event shards"), so a project is not
  bound by one Durable Object's 10 GB; each month may hold up to 10 GB.
  Events stored by 0.1 in the head's own table stay where they are and are
  queried as one more shard; upgrading moves no data.
- Every query result is exact and identical to one-store SQL: shards
  return event-level rows keyed by distinct id; the head resolves persons,
  applies person filters and breakdowns, and aggregates.
- Ingestion is exactly-once for person processing: the head keeps the
  uuids it has processed for 7 days and inserts into shards with
  `INSERT OR IGNORE`.
- `wrangler dev` and the tests run the same code (local Durable Objects).

Check: the shard tests (600 events over 50 days) give identical trends,
funnels, retention and event pages for day shards, month shards and
legacy + shards; purge drops whole shards; deleting a person deletes their
events from every shard.

### R16. Session replay

- `POST /s/` (also `/s` and `/i/v0/s`) accepts posthog-js recorder
  batches of `$snapshot` events in every body encoding of `protocol.md` 4
  and answers `{"status":1}` (`protocol.md` 11). Snapshots for projects
  with recording off, or unknown tokens, are dropped.
- Each request's rrweb events are stored per session as one gzip JSON
  chunk in R2; per-session metadata (person, start, end, clicks, key
  presses, console errors, first URL, size, chunk count) is kept in the
  head through the queue.
- `GET /api/projects/:id/session_recordings[/:session]` list and describe
  recordings; `…/snapshots` returns every rrweb event in time order with
  posthog-js's field compression (`cv: "2024-10"`) undone, ready for
  rrweb-player. Recordings can be deleted.
- The Recording screen plays the session with rrweb-player (MIT), loaded
  only on that screen, beside the session's events.

Check: the recorded `/s/` bodies give one recording with 10 clicks and 4
key presses whose snapshots contain a decompressed full snapshot and no
`cv` marker; in the e2e the recorder posts to `/s/`, the password field is
masked, and the player mounts.

### R17. Experiments

- An experiment has a name, a multivariate feature flag (created off with
  `control` and `test` at 50/50 unless an existing multivariate flag is
  named), and 1-10 metrics: conversion (a funnel of 1-10 steps within a
  window), event count per person, or the sum of a numeric property per
  person. Launch turns the flag on and starts the clock; stop ends it.
- A person's exposure is their first `$feature_flag_called` event for the
  flag (variant = `$feature_flag_response`) between start and end; persons
  seen with two variants are excluded. Metrics count only events at or
  after the person's exposure.
- Statistics are Bayesian (`design.md`, "Experiments"): Beta-Binomial for
  conversion, Gamma-Poisson for counts, Normal approximation for sums;
  probability to be best, 95% credible intervals, uplift against control
  and expected loss from 20,000 seeded Monte Carlo draws. A metric is
  significant when one variant's probability to be best is at least 95%
  and every variant has at least 50 exposures.

Check: the Monte Carlo probability agrees with the closed form for two
Beta posteriors within 0.012; the experiment test gives the hand-counted
exposures and conversions and ignores events before exposure.

### R18. Surveys

- Create, edit, launch, stop, resume and delete surveys: popover or API
  type, 1-20 questions (open, link, rating 3/5/7/10-point, single and
  multiple choice), and display conditions (URL contains, triggering
  events). New surveys default to `appearance.whiteLabel: true`.
- `GET /api/surveys/?token=<project token>` answers posthog-js with the
  running surveys (`protocol.md` 12), and remote config says `surveys:
  true` while any runs, so posthog-js loads `surveys.js` and shows them.
- Results come from the SDK's `survey shown`, `survey dismissed` and
  `survey sent` events: persons shown, responses (one per
  `$survey_submission_id`), dismissals, response rate, and per question a
  rating distribution with NPS for 0-10 scales, choice counts, or the
  latest text answers.

Check: with the recorded survey events, results show one NPS answer of 9
(NPS 100), "Friend" once and the text "Great product"; in the e2e
posthog-js shows the popover after the trigger event and the answers
arrive.

## Definition of done

`npm test` and `npm run e2e` pass, and a deploy following `design.md`
("Deploy") ingests the snippet's events from a real site and shows them in
Events within a few seconds, records and plays back a session, shows a
running survey and reports an experiment's exposures.
