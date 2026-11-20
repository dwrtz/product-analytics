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
SQL (optionally over a Basin / R2 Iceberg cold tier), run A/B experiments on multivariate flags and run targeted surveys that
posthog-js shows to visitors. Since 0.5 it also groups posthog-js and
posthog-node exceptions into issues (with source-map symbolication), keeps
each project inside monthly usage caps with sampling, shows what drives
volume and an estimated Cloudflare cost, and alerts the owner in the app
and by email. Since 0.6 it adds LLM analytics (generations, traces, costs
and latency from the PostHog AI SDKs), release tracking, merging and
splitting, assignment, grouping and suppression rules and retroactive
symbolication for errors, Python, Go and Rust stack traces, Trends over
the cold tier, request and dropped-past-cap counters, and an optional
read-only public demo mode.

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

## Out of scope for 0.6

- Web experiments, product tours, early access features, logs, data
  warehouse, CDP destinations and notebooks. The
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
- Cold tier (R27): Trends (total, daily users, unique sessions, no
  breakdown or compare) and the SQL editor read it; funnels, retention and
  the other screens read the hot shards only. The Worker never deletes
  Iceberg rows (Basin SQL is read-only); retention is enforced in every
  cold query and rows past it are physically deleted outside the Worker by
  `scripts/cold-prune.py`.
- Error tracking (R28-R29): native mobile symbolication (iOS dSYM, Android
  ProGuard/R8, React Native Hermes); server stacks (Python, Go, Rust, Node)
  are shown as the SDK sent them. Source maps with `url` sections. Teams
  and roles as assignees (assignees are users of the instance). Re-grouping
  issues already stored when a grouping rule changes.
- LLM analytics (R31): prompt management, evaluations, playground,
  datasets, sentiment and clustering; costs come from the SDK or a
  built-in list-price table, not from provider invoices.
- Usage (R30): billing, per-person or per-event-name caps, scale and load
  testing.
- Per-project permissions, organizations, invitations, SSO, billing. The
  public demo (R32) is read-only for everyone who is not signed in; it is
  not a sharing or permissions system.
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
  R2 bucket `REPLAY` (recording chunks and source maps); Queue `INGEST`
  (producer and consumer on the same Worker, with a dead-letter queue);
  Assets `ASSETS`; optional `send_email` binding `EMAIL` (R30).
  Vars `SITE_URL`, `ALLOWED_EMAILS`, `DEFAULT_RETENTION_DAYS`,
  `REPLAY_RETENTION_DAYS` and optional `INGEST_HOSTS` (R2) and
  `ALERT_EMAIL_FROM` (R30) and `PUBLIC_DEMO` (R32) (`SHARD_PERIOD` exists for tests only). No
  secrets. A daily cron trigger applies data retention and checks for
  usage spikes. Exact config in
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
- Every hostname routed to the Worker serves the full app by default. An
  optional `INGEST_HOSTS` var (comma-separated hostnames, case-insensitive,
  empty by default) makes listed hostnames ingest-only, for a first-party
  ingest subdomain on a measured site (for example `analytics.<your-site>`)
  while the dashboard stays on `SITE_URL`: they serve the SDK endpoints
  (capture, `/flags`, `/decide`, remote config, `/s/`, `/api/surveys`,
  `/static/*`, local evaluation), `/_health` and requests with an
  `Authorization` header; other `GET`/`HEAD` requests redirect (302) to the
  same path on `SITE_URL`, and other methods get 421
  `{"error":"wrong_host"}`. The `SITE_URL` hostname is never ingest-only.

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
picker for series. 0.6 adds LLM analytics (overview, traces, trace),
release, assignee and merge controls on Error tracking, grouping and
suppression rules in Settings, and a Hot / Cold source on Trends. Usable
on a phone (390 px wide).
- Any `GET` or `HEAD` that is not an API, SDK or static path and has no
  file extension serves the app's HTML (deep links and reloads work),
  unless `Accept` asks for JSON without HTML or `*/*`; then it is a JSON
  404.

Check: the screenshots in `shots/`, `shots03/` and `shots06/` are taken
from the reference build; `tests/v06.test.ts` covers the HTML fallback.

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

### R27. Cold tier (optional; Basin)

- When the instance has a `COLD_STREAM` binding (a Basin Pipelines stream)
  the queue consumer also sends every ingested event to it as
  `{project_id, uuid, event, distinct_id, timestamp, ts, properties}`
  (`timestamp` RFC 3339, `ts` epoch ms, `properties` a JSON string). A
  pipeline writes them to an Apache Iceberg table in R2 (Basin Catalog,
  default `analytics.events`). Delivery is at least once.
- With `BASIN_TOKEN`, `BASIN_ACCOUNT_ID` and `BASIN_BUCKET` also set,
  `GET /api/config` reports `cold_tier: true` and
  `POST /api/projects/:id/sql` with `"source": "cold"` runs the R22 query
  language against that table through Basin SQL: the same AST is compiled
  to one Basin SQL statement (`design.md`, "Cold tier"). The compiler
  always adds `project_id = <project>` and, when the project has a
  retention period, `timestamp >= now - retention_days`, so a project
  never sees another project's rows or rows past its retention. `persons`
  and person columns are a 400 on the cold source. The response is the
  R22 shape plus `source: "cold"` and `scanned: {bytes, files}`.
- The SQL screen shows a Hot / Cold source picker only when `cold_tier`
  is true. Without the bindings nothing changes.
- 0.6: `POST /api/projects/:id/query` with `{"source": "cold", "query":
  <TrendsQuery>}` answers Trends from the cold table: one Basin SQL
  `GROUP BY` per series over the same interval buckets as the hot engine
  (time zone and DST aware, at most 400 buckets), with the project and
  retention conditions always added. `total`, `dau` (distinct ids, not
  merged persons) and `unique_session` are supported; breakdowns, compare,
  actions, cohort and person filters and other maths answer 400 with a
  message naming the hot source. The Trends editor shows a Source picker
  when `cold_tier` is true; a saved cold insight on an instance without a
  cold tier falls back to hot with a note. Without the cold tier the API
  answers 400 "not configured".
- 0.6: `scripts/cold-prune.py` (PyIceberg against the R2 Data Catalog REST
  API; `--warehouse`, `--catalog-uri`, `--retention-days`,
  `--project-id`, `--dry-run`; token from `R2_CATALOG_TOKEN`, never
  printed) physically deletes rows past retention, and
  `scripts/cold-prune.workflow.example.yml` runs it weekly from GitHub
  Actions.

Check: `tests/cold.test.ts` (forced filters, quoting, numeric property
access, week start, rejections); a live run sends events, waits for the
pipeline (about two minutes with a 60 s roll) and finds them with a cold
query, with an event older than the retention period excluded. 0.6:
`tests/v06.test.ts` "cold Trends" (statements, forced filters, retention
clamp, rejections, a stubbed Basin run) and
`python3 -m unittest scripts/test_cold_prune.py` (`--help`, cutoff,
arguments, token never printed).

### R28. Error tracking

- `$exception` events from posthog-js (`captureException`, exception
  autocapture) and posthog-node (`captureException`) are grouped into
  *issues* at ingest (`protocol.md` 19). The fingerprint is the event's
  `$exception_fingerprint` when sent (string, or a list joined with `|`);
  otherwise the outer exception's type plus its top five in-app frames
  (function and filename without build hashes, innermost first, no line
  numbers), or the type plus the message with numbers, ids and quoted
  values removed when there is no stack. The stored event gets
  `$exception_fingerprint` and `$exception_issue_id`.
- An issue has a status (`active`, `resolved`, `suppressed`), first and
  last seen, occurrences, affected users (distinct ids), regressions, and
  the latest exception list. An occurrence after an issue was resolved
  reopens it as a regression. Counting is idempotent per event uuid.
- Remote config (`/array/<token>/config(.js)`, `/flags?config=true`,
  `/decide`) sends `autocaptureExceptions` and
  `errorTracking.autocaptureExceptions` from the project's
  `error_tracking` switch, so posthog-js captures unhandled errors and
  promise rejections. New projects have it on; existing projects off. It
  is off while the project's events are capped in drop mode.
- Screens: an issues list (status tabs with counts, search, sort, 14-day
  sparkline, occurrences, users, first and last seen) and an issue page
  (stack trace with source context, status actions, facts, 30-day chart,
  recent occurrences linking to the person and to the session recording
  when one exists).
- Owner API: `GET /api/projects/:id/error_issues?status=&search=&order=`,
  `GET` and `PATCH` (`{status}`) `/api/projects/:id/error_issues/:issue`.
- 0.6 releases: an exception's release is the first non-empty of
  `$release`, `release`, `$app_version`, `app_version`
  (`test-vectors.json` "releases"). Occurrences store it; issues have
  first and last seen release; `?release=` filters the list;
  `GET /error_issues/releases` lists releases with counts.
- 0.6 merge and split: `POST /error_issues/:id/merge {ids}` folds up to 50
  issues into one (their fingerprints point to it, counts are recomputed,
  merged issues are hidden but kept); `POST /error_issues/:id/split
  {fingerprint}` moves that fingerprint's occurrences to their own issue
  (restoring a merged issue when there was one). The issue page lists its
  fingerprints with a Split action; the list has checkboxes and "Merge
  selected".
- 0.6 assignment: `PATCH {assignee}` takes a user of the instance by email
  or id (or `null`); `?assignee=me|none|<id>|<email>` filters.
- 0.6 grouping rules: `/error_grouping_rules` (CRUD; field `type`,
  `value`, `filename` or `function`; match `contains`, `exact` or
  `regex`; a group key). The first enabled rule that matches sets the
  fingerprint `rule:<key>`; `$exception_fingerprint` still wins and the
  default fingerprint applies when no rule matches.
- 0.6 suppression rules: `/error_suppression_rules` (CRUD) in posthog-js's
  shape `{type: AND|OR, values: [{key: $exception_types|$exception_values,
  operator, value, type}]}`. Remote config sends them as
  `errorTracking.suppressionRules`, so posthog-js drops matching exceptions
  before sending; any that still arrive are dropped at ingest and counted
  as suppressed on the Usage screen (`test-vectors.json`
  "suppression_rules").
- 0.6 server stacks: `$exception_list` frames from posthog-python,
  posthog-go and posthog-rs (any `platform` other than JavaScript or Node)
  are kept as sent: they are fingerprinted and shown with their module
  and source context but never sent to source-map symbolication.

Check: `tests/v05.test.ts` groups the recorded posthog-js and posthog-node
exceptions into five issues, resolves one and sees the regression; the
e2e captures an unhandled error with real posthog-js and a posthog-node
exception and opens the issue page. 0.6: `tests/v06.test.ts` (releases,
merge, split, assignment, grouping and suppression rules, Python, Go and
Rust stacks); the e2e sends server-SDK stacks through `/batch/`, merges,
splits, assigns and checks the suppression rules in remote config.

### R29. Source maps

- `PUT` (or `POST`) `/api/projects/:id/symbol_sets?url=<URL or path of the
  minified file>` with the source map JSON as the body (version 3, not
  sectioned or an index map with inline `map` sections, at most 25 MB) stores the map in R2 under
  `sourcemaps/<project>/`. Personal API keys work, so CI can upload; the
  same URL replaces the old map. `GET` lists maps, `DELETE
  /symbol_sets/:id` removes one. Deleting the project deletes its maps.
- At ingest each frame whose filename matches a map (the URL without
  query, else the same path, else a path suffix at a `/` boundary) is
  resolved to the original file, line and column, with up to five lines
  before and three after from `sourcesContent`; the frame keeps its
  minified location in `minified`. A frame's original function name is the
  name mapped at its caller's call site.
- `scripts/upload-sourcemaps.mjs --host --project --dir --url-prefix`
  (Node 18+, no dependencies, key in `PA_PERSONAL_API_KEY`) uploads the map
  of every `.js` file under a build directory.
- 0.6 releases: `?release=` (and `--release` on the script) scopes a map
  to exceptions from that release; one URL can have a map per release. An
  exception uses its release's map, else the map uploaded without a
  release.
- 0.6 retroactive symbolication: an upload re-symbolicates up to 2,000
  occurrences from the last 30 days that still have unresolved frames in
  that file (and release): the issue's sample stack and top frame are
  updated and the resolved fingerprint is linked to the issue, so later
  occurrences group with it. Events already stored in the shards keep the
  frames they arrived with. The response reports `resymbolicated:
  {scanned, symbolicated, issues}`.

Check: the VLQ decoder and frame resolution against an esbuild map
(`test-vectors.json` "source_maps" and, for index maps,
"source_map_sections"); the upload, symbolicated stored event and issue
frames over HTTP; 0.6 per-release maps and retroactive symbolication in
`tests/v06.test.ts` and the e2e.

### R30. Usage limits, sampling, usage page and alerts

- Each project may have `limits` (`design.md` "Usage limits"): monthly
  caps (UTC calendar month) on events, new session recordings and stored
  replay bytes; what happens past a cap (`drop`, or `sample` with a kept
  share); an autocapture sample rate; alert recipients and the spike
  factor. Projects created from 0.5 on start with 1,000,000 events,
  5,000 recordings and 5 GB of replay a month, drop past the cap,
  autocapture sampled at 50% of sessions and the replay sample rate at
  25%. Projects without `limits` behave exactly as before.
- The project store counts accepted events per received day and event
  name exactly and applies the cap; replay chunks over a replay cap are
  refused and their R2 objects deleted. Sampling is deterministic
  (`test-vectors.json` "sampling"): by distinct id for events past a cap,
  by session id for replay and autocapture.
- When a cap is reached the store writes the month's `cap_state` to D1.
  The capture endpoints read it (cached up to 10 s per isolate) and in
  drop mode answer `quota_limited` (`protocol.md` 20) so posthog-js
  pauses sending; remote config then turns session recording and
  exception autocapture off. Raising a cap lifts the state at once.
- The Usage screen shows month-to-date meters against each cap, events per
  day stacked by event type with a table of what drives volume, replay
  recordings and bytes per day, and an estimated Cloudflare cost for the
  month. 0.6: the headline is the list price; "After Workers Paid
  included allowance" is a secondary toggle that notes it assumes this is
  the only workload on the account. The estimate counts every Worker
  request: capture, flags (`/flags`, `/decide`, flag definitions, local
  evaluation), remote config (`/array/…/config`), owner API and requests
  refused at the edge.
- 0.6 counters: the edge counts flag, config and owner API requests and
  events, requests and replay uploads dropped past a cap without waiting
  (batched per isolate, flushed within about 2 s through the project
  store). The Usage screen and API show "Dropped past cap" (`events`,
  `requests`, `replay_uploads`) and requests by type.
- Alerts are stored per project and shown on the Usage screen (with an
  unread badge in the navigation): 50%, 80% and 100% of each cap, a daily
  spike (yesterday over 3x the previous 7-day average, at least 100
  events; daily cron), new issues and regressions (not for suppressed
  issues). With a Cloudflare Email Sending binding `EMAIL` and an
  `ALERT_EMAIL_FROM` sender on an onboarded domain each alert is also
  emailed (to the project's alert emails, else every user; at most 20
  emails per project per day); without them alerts are in-app only.
  `POST /api/projects/:id/alerts/test` sends a test alert.
- Owner API: `GET /api/projects/:id/usage?days=`, `GET /alerts`,
  `POST /alerts/read`, `POST /alerts/test`; `limits` and `error_tracking`
  in the project `PATCH` and in project responses (with `cap_state`).

Check: `tests/v05.test.ts` (exact counting and drop past the cap, the
three threshold alerts, `quota_limited` at the edge, lifting the cap,
sample mode, autocapture sampling, replay cap with chunk deletion and
recorder off, spike alert, email delivery through a stub binding); the
e2e shows real posthog-js stopping after a `quota_limited` answer.

### R31. LLM analytics

- Ingestion: `$ai_generation`, `$ai_trace`, `$ai_span`, `$ai_embedding`
  (and any `$ai_*` event) are stored like other events from the standard
  capture paths (`/i/v0/e`, `/batch`, `/e`, v1) and from the AI endpoints
  the PostHog AI SDKs use (`protocol.md` 21): `/i/v0/ai/batch` (legacy
  batch body), `/i/v1/ai/events` (v1 batch) and `/i/v0/ai` (multipart with
  exactly an `event` part and an optional `event.properties` part, Bearer
  token, optional gzip). The AI endpoints drop non-`$ai_` events as
  `misrouted_event`.
- Cost per generation or embedding: the SDK's `$ai_total_cost_usd`, else
  `$ai_input_cost_usd + $ai_output_cost_usd`, else list prices from
  `src/shared/llm-pricing.ts` by model (OpenAI, Anthropic, Google, xAI,
  DeepSeek, Llama), with cached input tokens priced as cached
  (`test-vectors.json` "llm_costs"). Unknown models have no cost and are
  counted as unpriced.
- Screens (nav "LLM analytics"): Overview (generations, embeddings,
  traces, users, input and output tokens, cost, p50 and p95 latency, error
  rate, generations and errors per interval, cost per interval, a model and
  provider table); Traces (filters for model, provider, status and search;
  name, person, models, spans, tokens, cost, latency, status); Trace (span
  tree by `$ai_parent_id` with a latency waterfall, a selected span's
  model, tokens, cost, error and expandable `$ai_input` and
  `$ai_output_choices`, the trace's input and output state, person and
  session links).
- Owner API: `GET /api/projects/:id/llm/overview?date_from=&date_to=&interval=&model=&provider=`,
  `GET /llm/traces?…&status=&search=`, `GET /llm/traces/:trace_id?ts=`.

Check: `tests/v06.test.ts` "LLM analytics" (pricing; batch, multipart and
v1 endpoints; misrouted events; overview totals, traces filters and the
trace tree); the e2e sends a generation with posthog-node, a batch and a
multipart event, then opens the overview and trace screens.

### R32. Public demo (optional)

- With the var `PUBLIC_DEMO` set to `1` (off by default), signed-out
  visitors can open every screen of projects the owner marked
  `public_demo` (Settings, or `PATCH {public_demo: true}`), read only. Other
  projects stay private (404).
- Reads and read-only posts (`/query`, `/sql`) work; every other `POST`,
  `PATCH`, `PUT` and `DELETE`, flag definitions for local evaluation and
  the test alert answer 403 `{"error": "demo_read_only"}`.
  `ALLOWED_EMAILS` still applies to sign-up and sign-in, and a signed-in
  owner keeps full access.
- Responses to visitors are redacted: user and alert-recipient emails,
  and the creator and assignee emails stored with insights and issues
  (even of accounts removed since), become `owner@hidden`, `alert_emails` is empty, personal API keys are an
  empty list and the project API key is replaced by a placeholder.
- The web app shows a "Read-only public demo" banner with an owner sign-in
  link and disables write controls. `scripts/demo-setup.mjs` builds a demo
  project with data on every screen and marks it `public_demo`, against
  `wrangler dev` or a live URL.

Check: `tests/v06.test.ts` "public demo" (off by default, reads, 403s,
redaction, private projects, ALLOWED_EMAILS); the e2e checks the API and
the banner as a signed-out browser when the instance runs with
`PUBLIC_DEMO=1`.

## Definition of done

`npm test` and `npm run e2e` pass, and a deploy following `design.md`
("Deploy") ingests the snippet's events from a real site and shows them in
Events within a few seconds, records and plays back a session with its
console log, shows a running survey, reports an experiment's exposures,
draws a click heatmap and answers a SQL query; since 0.5 it also groups a
real browser exception into an issue with a symbolicated stack trace,
shows the Usage screen and answers `quota_limited` past a cap; since 0.6
it also shows a posthog-node LLM generation in LLM analytics with its
trace, re-symbolicates an exception when its release's map is uploaded,
counts events and requests dropped past a cap, and (with `PUBLIC_DEMO=1`)
shows a demo project read-only to a signed-out visitor.
