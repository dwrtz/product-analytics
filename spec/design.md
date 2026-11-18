# Design

How the reference build meets `spec.md`. Another build may differ inside
these lines as long as every requirement and check in `spec.md` still holds;
names here (bindings, tables, routes) are the ones the tests and scripts use.

## Stack

- **Runtime:** one Cloudflare Worker (TypeScript, ES modules) with a
  SQLite-backed Durable Object class, a D1 database, a Queue with a
  dead-letter queue, static assets and a daily Cron Trigger.
- **Libraries (runtime):** `lz-string` (LZ64 bodies). Everything else is
  Web platform: `DecompressionStream` (gzip, deflate), `crypto.subtle`
  (SHA-1 flag hashing, SHA-256, PBKDF2), `Intl.DateTimeFormat` (time zones).
- **SDK files:** the `posthog-js` package (Apache-2.0 and MIT) as a dev dependency; the
  build copies its `dist/*.js` and `LICENSE` to `public/static/`.
- **Web app:** vanilla TypeScript, no framework, SVG charts, bundled by
  esbuild into `src/worker/ui.gen.ts` (JS and CSS as strings, plus
  `app_name`), so the Worker serves `/`, `/app.js` and `/app.css` itself
  and the assets binding serves only `/static/*`.
- **Tooling:** Wrangler 4, TypeScript, esbuild, Vitest 5 with
  `@cloudflare/vitest-plugin` (tests run inside workerd with real D1,
  Durable Objects and Queues), Playwright and `posthog-node` for the e2e
  suite. Node 22 or later.
- **Settings:** `spekkr.inputs.json` at the project root,
  `{"app_name": "...", "brand_color": "#rrggbb"}`. The UI build reads it:
  `app_name` in the title, nav and sign-in screen; `brand_color` as the
  CSS `--brand` variable (buttons, links, the first chart series).

Layout:

```
src/shared/   decode.ts timestamp.ts ids.ts flags.ts dates.ts   (pure, unit-tested)
src/worker/   index.ts env.ts capture.ts sdk.ts projects.ts auth.ts api.ts store.ts query.ts ui.gen.ts
src/ui/       app.ts style.css
migrations/   0001_init.sql
scripts/      build-ui.mjs copy-sdk.mjs gen-vectors.mjs seed-demo.mjs demo-setup.mjs shots.mjs
tests/        setup.ts vectors.test.ts store.test.ts http.test.ts
e2e/          e2e.ts
```

## Storage: why a Durable Object per project

Product analytics needs exact counts (people, funnels, retention), joins
between events and mutable persons, JSON properties, window-style
per-person scans, and it has to run under `wrangler dev` with no account.
The options on Cloudflare:

| Option | Fit |
|---|---|
| **SQLite Durable Object per project** (chosen) | Full SQLite with JSON functions, transactions and indexes next to the data; exact answers; one writer per project serializes person merges with no locking; runs locally and in Vitest; no API token in the Worker. Limit: 10 GB per object, and one object's CPU per query. |
| D1 | Same SQL, but one 10 GB database for every project and a network hop per statement; person merges across many statements would need care. Used for the small instance tables. |
| Workers Analytics Engine | Built for this write pattern, but it samples at high volume (counts become estimates), has no mutable persons, no joins, and its SQL API needs an account API token, also in local dev. |
| Basin (Pipelines into R2 Iceberg, queried with Basin SQL) | The scale-out path for very large projects. Not for 0.1: no local emulation, query latency in seconds, a token in the Worker, and tables are append-only, so persons and merges would still live elsewhere. |

So: **D1** holds the instance (users, sessions, personal API keys,
projects). **One `ProjectStore` Durable Object per project**, addressed by
`idFromName("project:<id>")`, holds that project's events, persons,
distinct ids, groups, definitions, insights, dashboards and flags.
Ingestion goes **capture → Queue → consumer → ProjectStore**, so capture
answers fast, bursts are smoothed, and failed writes are retried and finally
parked in the dead-letter queue. Nothing in code names a database id,
account, domain or token: all of it comes from `wrangler.jsonc` and vars.

Size guidance: an event row is about 1-2 KB with typical posthog-js
properties, so one project holds roughly 5-10 million events before the
10 GB limit; `retention_days` with the daily purge keeps a project under it.
Settings shows the project's database size.

## Cloudflare config (`wrangler.example.jsonc`)

```jsonc
{
  "name": "product-analytics",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-11-16",
  "workers_dev": false,
  "preview_urls": false,
  "d1_databases": [{ "binding": "DB", "database_name": "product-analytics", "database_id": "<from d1 create>", "migrations_dir": "migrations" }],
  "durable_objects": { "bindings": [{ "name": "STORE", "class_name": "ProjectStore" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ProjectStore"] }],
  "queues": {
    "producers": [{ "binding": "INGEST", "queue": "product-analytics-ingest" }],
    "consumers": [{ "queue": "product-analytics-ingest", "max_batch_size": 100, "max_batch_timeout": 2, "max_retries": 10, "dead_letter_queue": "product-analytics-ingest-dlq" }]
  },
  "assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": true },
  "vars": { "SITE_URL": "http://localhost:8787", "ALLOWED_EMAILS": "", "DEFAULT_RETENTION_DAYS": "0" },
  "triggers": { "crons": ["17 3 * * *"] },
  "observability": { "enabled": true }
}
```

`wrangler.jsonc` is a copy with the real `database_id`, `SITE_URL` and
`ALLOWED_EMAILS` (and a `routes` entry for a custom domain); it is not
committed. Vars:

| Var | Meaning |
|---|---|
| `SITE_URL` | The app's own origin, no trailing slash. Owner API writes with a session cookie must send this exact `Origin`; the snippet in Settings uses it as `api_host`; cookies get `Secure` when it is https. |
| `ALLOWED_EMAILS` | Comma-separated emails that may sign up. Empty: only the first account can sign up. |
| `DEFAULT_RETENTION_DAYS` | Retention for new projects, in days. Empty or `0`: keep events forever. |

There are no secrets.

## Deploy

With an API token scoped to the target account (Workers Scripts, D1,
Queues edit; Workers Routes and DNS edit on the zone when a custom domain is
used):

1. `npm install`, then `cp wrangler.example.jsonc wrangler.jsonc`.
2. `npx wrangler d1 create product-analytics`; put the id in
   `wrangler.jsonc`.
3. `npx wrangler queues create product-analytics-ingest` and
   `npx wrangler queues create product-analytics-ingest-dlq`.
4. `npx wrangler d1 migrations apply DB --remote`.
5. Set `SITE_URL` to the public origin and `ALLOWED_EMAILS` to the owners'
   emails **before** the first deploy (otherwise whoever signs up first owns
   the instance). For a custom domain add
   `"routes": [{ "pattern": "<host>", "custom_domain": true }]`.
6. `npm run deploy` (builds the UI, copies the SDK files, uploads them as
   assets with the Worker).
7. Open `SITE_URL`, sign up, create a project, paste the snippet into a
   site, and check events arrive in Activity.

Upgrades: `npm run deploy`; new D1 migrations with step 4. The Durable
Object creates and upgrades its own tables on start (`CREATE ... IF NOT
EXISTS`), so a new store schema version adds statements there.

## Data model

### D1 (`migrations/0001_init.sql`)

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL);
CREATE TABLE personal_api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, mask TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, api_token TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'UTC', retention_days INTEGER NOT NULL DEFAULT 0, anonymize_ips INTEGER NOT NULL DEFAULT 0,
  autocapture_opt_out INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
```

- Passwords: PBKDF2-SHA256, 100,000 iterations, 16-byte random salt,
  compared in constant time; an unknown email still costs one derivation.
- Sessions: 32 random bytes, base64url, in the `pa_session` cookie
  (`HttpOnly; SameSite=Lax; Path=/`, `Secure` on https, 30 days); only the
  SHA-256 is stored.
- Project tokens: `phc_` + 43 random base62 characters. Personal API
  keys: `phx_` + 43 base62; only the SHA-256 and a mask (`phx_...abcd`) are stored;
  the key is shown once.

### ProjectStore (SQLite in the Durable Object)

```sql
CREATE TABLE events (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, event TEXT NOT NULL, distinct_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL, properties TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX events_ts ON events (timestamp);
CREATE INDEX events_event_ts ON events (event, timestamp);
CREATE INDEX events_did_ts ON events (distinct_id, timestamp);
CREATE TABLE persons (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, properties TEXT NOT NULL DEFAULT '{}',
  is_identified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen_at INTEGER);
CREATE TABLE person_distinct_ids (distinct_id TEXT PRIMARY KEY, person_id INTEGER NOT NULL);
CREATE INDEX pdi_person ON person_distinct_ids (person_id);
CREATE TABLE group_types (idx INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE groups (group_type TEXT NOT NULL, group_key TEXT NOT NULL, properties TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, PRIMARY KEY (group_type, group_key));
CREATE TABLE event_definitions (name TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE TABLE property_definitions (kind TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (kind, name));
CREATE TABLE insights (id INTEGER PRIMARY KEY AUTOINCREMENT, short_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', query TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE dashboards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  date_from TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE dashboard_tiles (dashboard_id INTEGER NOT NULL, insight_id INTEGER NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (dashboard_id, insight_id));
CREATE TABLE feature_flags (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, filters TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
```

Times are integer ms UTC. Properties are JSON text. Property definitions
record a type per name (`Numeric`, `Boolean`, `DateTime` for ISO-looking
strings, otherwise `String`), first type wins; an in-memory set skips
already-known names.

## Ingestion path

1. Capture (`capture.ts`) decodes, validates the token, normalizes
   (`protocol.md` sections 2-6) and looks the project up by token (D1, with
   a 30-second per-isolate cache that is cleared on token reset, setting
   changes and project deletion in that isolate).
2. `enqueue` packs events into messages of at most 100 KB of JSON
   (`{pid, events}`) and sends them two per `sendBatch`. An event over
   100 KB on its own is written straight to the store.
3. The queue consumer groups messages by project and calls
   `ProjectStore.ingest(events)`; on error it retries the messages after
   10 seconds; after 10 tries they go to the DLQ.
4. `ingest` runs in one `transactionSync`: per event, `INSERT OR IGNORE`
   by uuid (a duplicate is skipped entirely), definitions,
   `$groupidentify`, then person processing (`protocol.md` section 7).
   It returns `{inserted, duplicates}`.

## Queries (`query.ts`)

The owner API posts a query object to `/api/projects/:id/query`; it runs
inside the project's store. Shapes follow PostHog's query schema names so
saved insights read naturally: `TrendsQuery`, `FunnelsQuery`,
`RetentionQuery`, `EventsQuery`.

**Person key.** Every query that counts people joins
`person_distinct_ids` and uses `COALESCE('p' || person_id, 'd' ||
distinct_id)`: an event's current person if it has one, else its distinct
id. Merges therefore apply to past events at once.

**Date ranges** (`dateRange.date_from` / `date_to`): `-Nh`, `-Nd`, `-Nw`,
`-Nm`, `-Ny` (relative to the start of today in the project time zone,
hours relative to now), `dStart` (today), `mStart`, `yStart`, `all` (from the
first event), `YYYY-MM-DD` (whole local day; as `date_to` the end of that
day), or any ISO time. Default from `-7d` to now.

**Buckets** are `[start, end)` intervals aligned in the project time zone:
hour, day, week (starting Sunday), month; daylight-saving days are 23 or 25
hours. At most 2000 buckets.

**Trends.** Up to 20 series, each `{event (null = all events), custom_name,
math, math_property, math_group_type_index, properties}`, plus global
`properties`, `interval`, `breakdownFilter {breakdown, breakdown_type:
event|person, breakdown_limit (default 25, max 100)}`, `compareFilter
{compare}` and `trendsFilter.display`.

- Maths: `total` (count), `dau` (distinct person keys per bucket),
  `unique_session` (distinct `$session_id`), `unique_group` (distinct
  `$groups[<type>]`), and over the numeric `math_property`: `sum`, `avg`,
  `min`, `max` (0 when empty), `median`, `p75`, `p90`, `p95`, `p99` (linear
  interpolation between closest ranks; events without a numeric value are
  left out).
- Result per series (and breakdown value): `{label, action {id, name,
  custom_name, order, math, math_property}, breakdown_value, data[],
  labels[], days[], count (sum of data), aggregated_value, compare_label}`.
- Breakdown: values are the property's text form; missing is
  `$$_none_$$` (shown "None"). The top `breakdown_limit` values by event
  count in the range are kept and the rest fold into `$$_other_$$`
  ("Other"). Breakdown values with no events are dropped.
- Aggregated displays (`BoldNumber`, `ActionsTable`, `ActionsPie`,
  `ActionsBarValue`) use one bucket for the whole range, so `dau` there
  counts distinct people over the range, not a sum of days.
- Compare: the previous period is the same length ending just before
  `from`; its series come after the current ones with `compare_label:
  "previous"` and the current period's labels.

**Funnels.** 2-20 steps (`series`), `funnelsFilter {funnelWindowInterval
(default 14), funnelWindowIntervalUnit second|minute|hour|day|week|month,
funnelOrderType ordered (default)|unordered}`, global `properties`,
breakdown. Only events inside the date range take part (as PostHog). Per
person key, events in time order:

- *Ordered* (PostHog's funnel UDF): a step-1 event starts a new chain,
  replacing the previous chain at step 1; an event of step k extends the
  chain that reached step k-1 if it is within the window of that chain's
  first event, unless that same chain already reached step k. The first
  chain to reach the furthest step counts, with its step times. One event
  can count for several steps when it matches them.
- *Unordered*: from each event that matches any step, count the distinct
  steps matched within the window; keep the best start.
- Result per step: `{action_id, name, custom_name, order, count,
  average_conversion_time, median_conversion_time}` (seconds from the
  previous step; null for step 1). With a breakdown, one list per value
  (the value at the person's first counted event), largest first.

**Retention.** `retentionFilter {period Hour|Day|Week|Month (default Day),
totalIntervals (1-60, default 8), retentionType retention_recurring
(default)|retention_first_time, targetEntity {id, properties},
returningEntity {id, properties}}`, global `properties`, and an optional
`dateRange.date_to` (the last cohort; default now). The date range's
`date_from` is not used.

- Cohort i = person keys that did the target event in interval i
  (recurring), or whose first-ever target event falls in interval i
  (first time).
- `values[k]` = how many of cohort i did the returning event in interval
  i+k (k = 0 is the cohort size).
- Result: `{results: [{date, label "Day 3", cohort_label, values:[{count}]}],
  period}`.

**Events.** `EventsQuery {event, properties, personId, distinctId, after,
before, limit (1-1000, default 100), cursor}` newest first; the cursor is
`<timestamp>_<row id>` from `next`, so paging is stable while events
arrive. Each row has the event, its time as ISO, properties and the
current person `{id, name}`.

**Property filters in queries** (`{key, value, operator, type: event|person}`):
`exact` (value or list; case-sensitive text match), `is_not`, `icontains`,
`not_icontains`, `gt`, `gte`, `lt`, `lte` (numeric), `is_set`,
`is_not_set`, `is_date_before`, `is_date_after`. Booleans compare as
`true`/`false`, numbers as SQLite prints them. Anything else (for example
`regex`) is 400 `invalid_query`. Keys are passed as bound JSON paths, never
spliced into SQL.

## Owner API

All routes are under `/api`, JSON in and out, errors as `{"error":
"<code>", "detail": "<text>"}` (the SDK routes use `protocol.md`'s shape). Auth is the session cookie or `Authorization: Bearer phx_...`
(a personal API key). A cookie-authenticated request other than GET or HEAD
must send `Origin` equal to `SITE_URL` (403 `bad_origin`).

| Route | Methods | Notes |
|---|---|---|
| `/api/config` | GET | `{app_name, site_url, signup_open}`; public |
| `/api/signup` | POST | `{email, name, password (≥10 chars)}` → 201 + cookie; 403 `email_not_allowed` or `signup_closed`; 409 `taken` |
| `/api/login`, `/api/logout` | POST | 401 `bad_credentials` |
| `/api/me` | GET | `{id, email, name}` |
| `/api/personal_api_keys` | GET, POST | POST `{label}` → `{key}` once |
| `/api/personal_api_keys/:id` | DELETE | |
| `/api/projects` | GET, POST | POST `{name, timezone}` (IANA, checked) |
| `/api/projects/:id` | GET, PATCH, DELETE | PATCH `{name, timezone, retention_days, anonymize_ips, autocapture_opt_out}`; DELETE removes the store |
| `/api/projects/:id/reset_token` | POST | new `phc_` token; the old one stops working |
| `/api/projects/:id/query` | POST | `{query}`; 400 `invalid_query` |
| `/api/projects/:id/events` | GET | `event`, `cursor`, `limit`, `person_id`, `distinct_id`, `properties` (JSON) |
| `/api/projects/:id/definitions` | GET | event names, property names and types, group types |
| `/api/projects/:id/property_values` | GET | `type=event|person`, `key`: up to 50 distinct values (persons, or the latest 5000 events) |
| `/api/projects/:id/stats` | GET | events, persons, events in 24 h, last event time, database bytes |
| `/api/projects/:id/persons` | GET | `search` (email, name or distinct id), `cursor`; `{results, next, total}` |
| `/api/projects/:id/persons/:uuid` | GET, DELETE | DELETE `?delete_events=1` also deletes the person's events |
| `/api/projects/:id/insights` | GET, POST | `{name, description, query}` → with `short_id` |
| `/api/projects/:id/insights/:short_id` | GET, PATCH, DELETE | |
| `/api/projects/:id/dashboards` | GET, POST | `{name, description, date_from, pinned}` |
| `/api/projects/:id/dashboards/:id` | GET, PATCH, DELETE | GET includes tiles with their insights |
| `/api/projects/:id/dashboards/:id/tiles` | POST | `{insight_id}` |
| `/api/projects/:id/dashboards/:id/tiles/:insight_id` | DELETE | |
| `/api/projects/:id/feature_flags` | GET, POST | `{key, name, active, filters}`; key `[A-Za-z0-9_-]{1,200}`, unique; variants must sum to 100 |
| `/api/projects/:id/feature_flags/:id` | GET, PATCH, DELETE | each change bumps `version` |

Other Worker routes: the SDK routes of `protocol.md`, `/_health`
(`{"ok":true}`), `/app.js`, `/app.css`, and every other GET path returns
the app shell (history routing). All app responses carry
`X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

## Screens

Left nav: app name, project switcher, Dashboards, Insights, Events,
Persons, Feature flags, Settings, Account. Mobile (≤760 px): the
nav becomes a wrapping top bar; tables scroll sideways.

- **Sign in / Sign up** (`/login`, `/signup`): sign-up hidden when
  `signup_open` is false.
- **Dashboards** (`/project/:id/dashboards`, `/:id`): list; a dashboard is
  a grid of insight tiles, each rendered with the dashboard's date range
  (`date_from` overrides the insight's), with add/remove tile and refresh.
- **Insights** (`/insights`, `/insights/new?kind=trends|funnels|retention`,
  `/insights/:short_id`): editor on the left (series or steps with event
  picker, math and property; filters; breakdown; interval; date range;
  compare; display; funnel window and order; retention period, intervals,
  type and events), result on the right: line or bar chart, bold number,
  table or pie (trends); horizontal step bars with conversion % and median
  time (funnels); cohort table shaded by % (retention, no date range).
  Save, rename, add to dashboard.
- **Events** (`/events`): table (event, person, URL or library, time),
  newest first, with Reload, an event-name filter, property filters, rows
  that expand to all properties, and "Load more".
- **Persons** (`/persons`, `/persons/:uuid`): searchable list with total
  and an "anonymous" tag; person page with properties, distinct ids, first
  and last seen, identified state, recent events, and "Delete person and
  events".
- **Feature flags** (`/feature_flags`, `/new`, `/:id`): list with release
  summary and an on/off switch; editor with key, description, active,
  condition sets (person property filters and rollout %), and either a
  payload or a variants table (key, rollout %, payload JSON); delete. (The
  API also takes a per-condition `variant` override; the 0.1 editor keeps
  one it finds but does not offer it.)
- **Settings** (`/settings`): project name, time zone, token (copy, reset),
  the snippet for this instance, retention days, discard IPs, autocapture
  off, usage (events, persons, last event, database size), other projects
  and a new-project form, delete project (type the name to confirm).
- **Account** (`/account`): signed-in email, personal API keys (create,
  shown once; revoke), sign out.

## Tests

- `tests/vectors.test.ts`: every case in `test-vectors.json` against
  `src/shared` (decoding, tokens, timestamps, ids, flag hash and matching)
  and capture responses over HTTP.
- `tests/store.test.ts`: person scenarios, dedupe, and trends, funnels and
  retention on a small hand-computed dataset (expected numbers written in
  the test), events cursor, flags, purge.
- `tests/http.test.ts`: accounts and sign-up policy, Origin check, capture
  in every body encoding, beacon, errors, CORS, v1, queue to store end to
  end, `/flags` and `/decide`, remote config, token reset.
- `e2e/e2e.ts` (`E2E_EMAIL=... npm run e2e` against `npm run dev`): makes
  a project; serves a customer page on 127.0.0.1 with the Settings snippet
  (plus `opt_out_useragent_filter: true`); Playwright loads it, clicks,
  identifies; `posthog-node` captures, identifies, aliases and evaluates a
  flag; then checks stored events, persons, a trend, a funnel and
  retention, and the web app's screens.
- Demo: `scripts/demo-setup.mjs <site> <email> <password>` makes the
  "Acme Store" project with 58 days of seeded data, five insights, a
  dashboard and two flags; `scripts/shots.mjs` takes the screenshots.

## Limits (0.1)

- 10 GB per project (Durable Object limit); use `retention_days`.
- Queries run on one Durable Object; a 30-second CPU budget per request.
  Ranges of a few million events are fine; larger ones should use a
  coarser interval or shorter range.
- The token cache can serve a reset or deleted token for up to 30 seconds
  in other isolates.
- No local flag evaluation (`/api/feature_flag/local_evaluation`), cohorts,
  actions, HogQL, session replay, experiments, surveys, data warehouse or
  exports. Replay data sent by an SDK is accepted and discarded.
