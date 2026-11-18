# Product Analytics

## What this builds

A self-hosted product analytics service on Cloudflare Workers that the
PostHog SDKs can send to unchanged. A site adds the usual posthog-js
snippet with `api_host` set to this instance (or a server uses posthog-node
with `host` set to it), and events, identified people, groups and feature
flags work as they do against PostHog Cloud. The owner signs in to a small
web app to explore events and people, build trends, funnels and retention
insights, pin them to dashboards, manage feature flags (also evaluated
locally by posthog-node), watch session recordings with their console and
network logs, see click heatmaps and scroll depth, define actions and
cohorts and use them everywhere filters go, query events with read-only
SQL, run A/B experiments on multivariate flags and run targeted surveys that
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
saved insights, dashboards, flags, actions, cohorts, experiments, surveys
and recording metadata; queries fan out to the shards a date range touches and are
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

## Out of scope for 0.3

- Web experiments, product tours, early access features, error tracking,
  logs, LLM analytics, data warehouse, CDP destinations and notebooks. The
  SDK endpoints for these answer "nothing configured" (`protocol.md` 9) so
  the SDKs stay quiet.
- Heatmaps: element-level click maps ("clickmaps" of autocapture elements
  with a toolbar), the posthog toolbar itself, screenshots taken by a
  server-side browser. The heatmap background is the live page in a frame
  or a recording's first full snapshot.
- Replay: playlists, comments, recording summaries and a recordings filter
  UI beyond person and date.
- Experiments: holdouts, secondary metric dashboards over time, sample
  size calculator, frequentist statistics, group-aggregated experiments,
  web (no-code) experiments.
- Surveys: translations, branching logic editor (stored and served if sent
  through the API), widget and hosted (external) survey pages, templates.
- Cohorts: lifecycle and "stopped/started performing" criteria, sequences,
  group (non-person) cohorts. Insights: lifecycle, stickiness and paths,
  group analytics screens, funnel trends and time-to-convert views.
- SQL: joins, subqueries, window functions, writes of any kind and the full
  HogQL language; the editor takes the subset in `design.md` ("SQL").
- Feature flags: flag-dependency conditions, group-aggregated flags,
  encrypted payloads, remote config flags.
- A cold tier for old events (Basin / R2 Iceberg): the export hook exists
  (`design.md`, "Cold tier") but needs operator-created Basin credentials.
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
API keys, sign out). 0.3 adds SQL, Actions, Action editor, Cohorts, Cohort
(editor and members), Heatmaps, replay settings in Settings, console and
network panels on Recording, targeting and schedule in the Survey editor,
cohort conditions and continuity in the Flag editor, and an event/action
picker for series. Usable on a phone (390 px wide).

Check: the screenshots in `shots/` and `shots03/` are taken from the
reference build.

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
  recordings; `…/snapshots` returns rrweb events in time order with
  posthog-js's field compression (`cv: "2024-10"`) undone, ready for
  rrweb-player. 0.3: `…/snapshots?paged=1` (and `?cursor=`) returns about
  16 MB of events per page with `next`, so recordings of any size play
  (there is no 64 MB cap). Recordings can be deleted.
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

### R19. Actions

- An action is a named list of steps; an event matches when it matches any
  step, and a step matches when every field it sets holds: `event`; `url`
  (`$current_url`; exact, contains or regex); for autocapture events a CSS
  `selector`, element `text` (exact, contains or regex) and link `href`
  over `$elements_chain`; and event property filters (`design.md`,
  "Actions").
- Actions are series and funnel steps in trends, funnels, retention
  (`{kind: "ActionsNode", id}`), experiment metrics, behavioural cohort
  criteria and survey triggers.

Check: the selector tests (tag, id, class, attribute, `:nth-child`,
descendant and child combinators) match the hand-built chains; in the e2e
`button#cta` + text "Buy" counts the one click and a URL action counts the
page view, also as funnel steps.

### R20. Cohorts

- A cohort is static (a list uploaded as CSV, distinct ids, emails or
  person ids, editable per person) or dynamic: OR of AND groups of
  criteria on person properties, behaviour (performed an event or action
  at least once, or N times compared with ≥, ≤, =, >, <, in the last T
  days/weeks/months/years, with optional event property filters), and
  membership of other cohorts, each negatable.
- Dynamic membership is recalculated on save, hourly (cron) and on demand;
  cohorts made only of person properties are also evaluated live.
- `{type: "cohort", key: "id", value, operator: "in" | "not_in"}` filters
  work in insights, experiment metrics, flag conditions and survey
  targeting.

Check: the cohort tests give the hand-counted members for property,
behavioural (single and multiple, negated) and nested cohorts; the e2e
counts a behavioural (action) cohort and a CSV cohort and filters trends by
both `in` and `not_in`.

### R21. Heatmaps and scroll depth

- When the project's heatmaps setting is on, remote config sends
  `heatmaps: true` and `captureDeadClicks: true`, and posthog-js's
  `$$heatmap` events (`protocol.md` 14) are stored like any event (hidden
  from Events unless asked for).
- `GET /api/projects/:id/heatmaps` aggregates clicks, rage clicks, dead
  clicks or mouse moves for a URL (exact, or `*` patterns) and date range
  into points (x as a fraction of the viewport width, y in 16 px rows,
  fixed-position flag, count or unique visitors); `/heatmaps/urls` lists
  pages with data; `/scroll_depth` gives the share of page views that
  scrolled at least each 5 % of the page from
  `$prev_pageview_max_scroll_percentage`.
- The Heatmaps screen overlays the points on the live page in a frame, or
  on the first full snapshot of a recording of that page, at a chosen
  width, and shows scroll depth as bars.

Check: the heatmap test aggregates recorded `$heatmap_data` into the
expected cells for both URL modes and viewport bounds; the e2e gets posthog-js
clicks and scroll depth for its page and the screen draws the overlay.

### R22. SQL editor

- `POST /api/projects/:id/sql` (and `/query` with `kind: "HogQLQuery"`)
  runs one read-only `SELECT` over `events` or `persons` of that project:
  columns, `properties.x`, `person.properties.x`, `person_id`, arithmetic,
  comparisons, `AND/OR/NOT`, `IN`, `LIKE`, `BETWEEN`, `IS NULL`, a
  whitelist of functions, aggregates (`count`, `sum`, `avg`, `min`,
  `max`, `uniq`, `countIf`, `sumIf`, `count(DISTINCT person_id)`),
  `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `OFFSET`.
- It is parsed into an AST (no SQL text is passed through), runs across
  every shard the time range touches and is merged in the head. At most
  10,000 result rows, 200,000 rows or groups per shard, 25 s; anything else
  (writes, `;`, joins, subqueries, unknown functions) is a 400.

Check: the SQL tests agree with hand counts for filters, grouping by event
and person properties, `uniq`, `HAVING` and ordering, and reject writes and
joins; the e2e runs an aggregate and the SQL screen shows results.

### R23. Local flag evaluation

- `GET /flags/definitions`, `/api/feature_flag/local_evaluation` and
  `/api/projects/:id/feature_flags/local_evaluation` answer posthog-node
  with a personal API key (`Authorization: Bearer phx_…`, else 401): every
  flag with its filters, the group type mapping and, with `send_cohorts`,
  property-only cohorts (`protocol.md` 15). An `ETag` lets the SDK poll
  with `If-None-Match` (304).
- Flags whose conditions need server state (behavioural or static cohorts,
  experience continuity) are marked so posthog-node falls back to `/flags`.

Check: posthog-node in the e2e evaluates a property flag locally (true and
false) and a behavioural-cohort flag through `/flags`.

### R24. Experience continuity

- A flag with `ensure_experience_continuity` keeps the value a visitor got
  while anonymous after they identify: when `/flags` carries
  `$anon_distinct_id`, a hash key override (the anonymous id) is stored for
  both ids and used for every distinct id of the person (`protocol.md`
  16). Experiment flags have it on by default.

Check: the continuity test keeps the variant across identify for a flag
with it on and re-hashes one without; in the e2e the experiment counts
the identified visitor once, in one variant.

### R25. Survey targeting, iterations and partial responses

- Surveys can target persons by property and cohort filters with a
  rollout percentage, require a linked flag (and variant), and show only
  on URLs (contains, exact, regex and negations), when a CSS selector
  exists, on device types, after a wait period since the last survey, on
  trigger events or actions, with cancel events. Targeting is served as
  posthog-js expects: a targeting flag and an internal flag that hides the
  survey after a person responded or dismissed (`protocol.md` 17).
- Iterations: `iteration_count` repeats every `iteration_frequency_days`;
  the current iteration is served and results can be split by iteration.
- With `enable_partial_responses`, every answered question is kept: the
  per-submission answers are merged (latest non-empty answer per
  question) and results count completed, partial and abandoned.

Check: the survey tests serve the targeting and internal flags, advance
iterations on schedule and merge partial submissions; the e2e answers a
partial-responses survey through the real popover.

### R26. Replay settings and no row limits

- Per project: sample rate, minimum duration, linked flag (and variant),
  URL triggers and blocklist (regex), event triggers with any/all
  matching, console log capture, network timing / headers / bodies,
  canvas recording (fps, quality) and masking, sent in remote config
  (`protocol.md` 18). The player shows console and network panels and
  replays canvas.
- Funnels, experiments and survey results have no row-loading limit:
  funnels count per distinct id first and then load events in person
  batches of at most 100,000 rows; survey events are paged per shard.

Check: the remote config test maps every setting to posthog-js's fields;
the streamed-funnel test gives the same result with a batch size of 3 as
in one pass; the e2e finds console and network plugin events and the
console panel.

## Definition of done

`npm test` and `npm run e2e` pass, and a deploy following `design.md`
("Deploy") ingests the snippet's events from a real site and shows them in
Events within a few seconds, records and plays back a session with its
console log, shows a running survey, reports an experiment's exposures,
draws a click heatmap and answers a SQL query.
