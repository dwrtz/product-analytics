# Design

How the reference build meets `spec.md`. Another build may differ inside
these lines as long as every requirement and check in `spec.md` still holds;
names here (bindings, tables, routes) are the ones the tests and scripts use.

## Stack

- **Runtime:** one Cloudflare Worker (TypeScript, ES modules) with two
  SQLite-backed Durable Object classes (`ProjectStore`, `EventShard`), a D1
  database, an R2 bucket, a Queue with a dead-letter queue, static assets
  and a daily Cron Trigger.
- **Libraries (runtime):** `lz-string` (LZ64 bodies). Everything else is
  Web platform: `DecompressionStream` (gzip, deflate), `crypto.subtle`
  (SHA-1 flag hashing, SHA-256, PBKDF2), `Intl.DateTimeFormat` (time zones).
- **SDK files:** the `posthog-js` package (Apache-2.0 and MIT) as a dev dependency; the
  build copies its `dist/*.js` and `LICENSE` to `public/static/`.
- **Web app:** vanilla TypeScript, no framework, SVG charts, bundled by
  esbuild into `src/worker/ui.gen.ts` (JS and CSS as strings, plus
  `app_name`), so the Worker serves `/`, `/app.js` and `/app.css` itself
  and the assets binding serves only `/static/*`. The replay player is
  `rrweb-player` 2.x (MIT, rrweb-io/rrweb), bundled by the same script into
  `playerJs` / `playerCss` and served as `/player.js` and `/player.css`;
  the Recording screen imports it on demand, so other screens do not pay
  for its ~320 KB.
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
src/shared/   decode.ts timestamp.ts ids.ts flags.ts dates.ts stats.ts   (pure, unit-tested)
src/worker/   index.ts env.ts capture.ts sdk.ts projects.ts auth.ts api.ts store.ts shard.ts eventsql.ts query.ts
              replay.ts experiments.ts surveys.ts ui.gen.ts
src/ui/       app.ts player.ts style.css
migrations/   0001_init.sql 0002_replay.sql
scripts/      build-ui.mjs copy-sdk.mjs gen-vectors.mjs seed-demo.mjs demo-setup.mjs shots.mjs demo-02.mjs shots-02.mjs
tests/        setup.ts vectors.test.ts store.test.ts http.test.ts shards.test.ts replay.test.ts experiments.test.ts
tests/fixtures/  snapshot-requests.json survey-events.json   (recorded posthog-js traffic, research.md)
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
projects). **One `ProjectStore` Durable Object per project** (the *head*),
addressed by `idFromName("project:<id>")`, holds that project's persons,
distinct ids, groups, definitions, insights, dashboards, flags,
experiments, surveys, recording metadata and the shard registry, and
**`EventShard` Durable Objects** hold its events, one per UTC month (next
section).
Ingestion goes **capture → Queue → consumer → ProjectStore**, so capture
answers fast, bursts are smoothed, and failed writes are retried and finally
parked in the dead-letter queue. Nothing in code names a database id,
account, domain or token: all of it comes from `wrangler.jsonc` and vars.

Size guidance: an event row is about 1-2 KB with typical posthog-js
properties, so one shard (one month) holds roughly 5-10 million events
before its 10 GB limit; the head holds no events (except 0.1 data) and
stays small. Settings shows the project's total size across its objects.

## Event shards (0.2: more events)

0.1 kept every event in the project's one Durable Object, so a project
stopped at 10 GB. 0.2 splits events by time, keeps every answer exact, and
keeps `wrangler dev` and the tests working with no account.

**Options considered.**

| Option | Verdict |
|---|---|
| **Time shards: one SQLite Durable Object per (project, UTC month)**, head does person work and final aggregation (chosen) | Exact; unbounded total size (10 GB per month, ~5-10 M events per month); old data is dropped by deleting whole objects; queries touch only the months in range and run in parallel; the same code runs in `wrangler dev` and Vitest; no new token. Cost: a query's person resolution and final aggregation run in the head, so a query's working set (rows grouped by distinct id) must fit in one isolate's memory. |
| Hash shards (by distinct id) | Spreads write load, but every query touches every shard, merges move a person's events between shards, and retention cannot drop objects. |
| D1 per project, or one D1 sharded by month | 10 GB per database and a network hop per statement; nothing gained over Durable Objects. |
| Workers Analytics Engine | Sampled at volume (not exact), no persons, needs an account token for SQL, not in local dev. |
| Basin (Pipelines → R2 Iceberg → Basin SQL) | Right for billions of events and ad-hoc SQL, but seconds of latency, append-only (persons still elsewhere), a token in the Worker and no local emulation. Kept as the next step: a deploy can add a Pipeline that copies normalized events to R2 Iceberg for warehouse queries without changing this design. |

**How it works.**

- Shard key: the event's timestamp in UTC, month granularity, named
  `<head id>:<YYYY-MM>` (`SHARD_PERIOD=day` gives day shards `YYYY-MM-DD`;
  tests use it to exercise many shards). The period is fixed per project in
  the head's `meta` table on first use, so changing the var later does not
  re-route old data. The head's `shards` table registers each shard with
  its `[start, end)` and an event count.
- Ingest (head `ingest`): drop uuids already in `ingest_log` (7 days) or
  in the legacy table or in flight in this object; group the rest by
  shard and `insert` them there in parallel (`INSERT OR IGNORE` by uuid);
  then, in one head transaction, update the registry counts, record the
  uuids in `ingest_log`, and run definitions, groups and person processing
  (`protocol.md` 7) in arrival order. A crash between the two steps
  retries the message: the shard ignores the duplicates and the head, not
  having logged them, processes persons exactly once. A retry of the same
  uuid more than 7 days later is stored once but could update persons
  twice (SDK retries happen within minutes).
- Legacy: events stored by 0.1 stay in the head's `events` table; the head
  queries that table with the same primitives as one more shard, so an
  upgraded instance keeps its history with no migration step.
- Queries are two-phase (`eventsql.ts`, `query.ts`): each shard whose
  period overlaps the range runs event-level SQL (event name, event
  property filters, event breakdowns, buckets) and returns compact rows
  keyed by `distinct_id`; the head maps distinct ids to persons
  (`person_distinct_ids` and `persons`, in chunks of 5,000), applies person
  property filters (the same semantics as SQL, `matchPerson`) and person
  breakdowns, then aggregates:
  - Trends: shards group by (bucket, distinct id, breakdown, session or
    group key) with count, sum, min, max and numeric count; the head sums
    counts, counts distinct person keys (`dau`), distinct session/group
    keys, and sums/averages; percentiles get raw values.
  - Funnels: shards stream `(distinct_id, ts, step bitmask, breakdown)` in
    time order; the head groups by person key across shards and runs the
    same ordered/unordered matcher as 0.1.
  - Retention: shards return distinct `(distinct_id, bucket)`; first-time
    retention asks every shard before the end for `MIN(timestamp)` per
    distinct id and takes the minimum per person.
  - Events: a k-way merge over shards on `(timestamp, uuid)`, newest
    first; the cursor is `<timestamp>_<uuid>`.
  Sums over floats are taken in a fixed order (persons sorted) so results
  do not depend on how data is sharded.
- Retention purge deletes shards whose period ended before the cutoff
  (`deleteAll`) and trims the boundary shard and the legacy table.
  Deleting a person with events deletes their distinct ids' events in
  every shard; deleting a project deletes every shard.
- Exactness: all counts are exact at every age; nothing is sampled or
  pre-aggregated.

**Limits.** 10 GB and about 5-10 M events per project per month; a query
holds its grouped rows in the head (about 100 bytes per (bucket, distinct
id) pair for trends and per matching event for funnels), so funnels over
tens of millions of matching events in one range should be split; Durable
Object RPC messages are limited to 32 MiB per shard response.

## Cloudflare config (`wrangler.example.jsonc`)

```jsonc
{
  "name": "product-analytics",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-11-16",
  "workers_dev": false,
  "preview_urls": false,
  "d1_databases": [{ "binding": "DB", "database_name": "product-analytics", "database_id": "<from d1 create>", "migrations_dir": "migrations" }],
  "durable_objects": { "bindings": [{ "name": "STORE", "class_name": "ProjectStore" }, { "name": "SHARDS", "class_name": "EventShard" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ProjectStore"] }, { "tag": "v2", "new_sqlite_classes": ["EventShard"] }],
  "r2_buckets": [{ "binding": "REPLAY", "bucket_name": "product-analytics-replay" }],
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
| `REPLAY_RETENTION_DAYS` | Days to keep session recordings (default 30); never longer than the project's event retention when that is set. `0` keeps them as long as events. |
| `SHARD_PERIOD` | `month` (default) or `day`; read once per project. For tests. |

There are no secrets.

## Deploy

With an API token scoped to the target account (Workers Scripts, D1,
Queues and R2 edit; Workers Routes and DNS edit on the zone when a custom
domain is used):

1. `npm install`, then `cp wrangler.example.jsonc wrangler.jsonc`.
2. `npx wrangler d1 create product-analytics`; put the id in
   `wrangler.jsonc`.
3. `npx wrangler queues create product-analytics-ingest`,
   `npx wrangler queues create product-analytics-ingest-dlq` and
   `npx wrangler r2 bucket create product-analytics-replay`.
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
Objects create and upgrade their own tables on start (`CREATE ... IF NOT
EXISTS`), so a new store schema version adds statements there.

**Upgrading 0.1 → 0.2:** create the R2 bucket, apply D1 migration
`0002_replay.sql` (adds `projects.session_recording`, default 0; existing
rows and data are untouched), deploy with the `v2` Durable Object
migration (new class `EventShard`). Existing events stay in each head's
legacy table and are queried as before; new events go to shards.

**Deploying without asset upload.** Wrangler uploads `/static` as Workers
Assets. A deploy pipeline that can only upload the script (for example
the Cloudflare API through a connector that cannot send the assets JWT)
can instead put the posthog-js files in the R2 bucket under `static/<file>`
and wrap the Worker so `ASSETS.fetch` reads `static/<file>` from `REPLAY`
(content type from the extension, CORS and caching added by the Worker as
usual). The app does not change.

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
-- migrations/0002_replay.sql
ALTER TABLE projects ADD COLUMN session_recording INTEGER NOT NULL DEFAULT 0;
```

- Passwords: PBKDF2-SHA256, 100,000 iterations, 16-byte random salt,
  compared in constant time; an unknown email still costs one derivation.
- Sessions: 32 random bytes, base64url, in the `pa_session` cookie
  (`HttpOnly; SameSite=Lax; Path=/`, `Secure` on https, 30 days); only the
  SHA-256 is stored.
- Project tokens: `phc_` + 43 random base62 characters. Personal API
  keys: `phx_` + 43 base62; only the SHA-256 and a mask (`phx_...abcd`) are stored;
  the key is shown once.

### ProjectStore (head; SQLite in the Durable Object)

The `events` table and its indexes are the 0.1 (legacy) events and also
the schema of every `EventShard` (which has only this table).

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
-- 0.2
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);                 -- shard_period
CREATE TABLE shards (key TEXT PRIMARY KEY, start INTEGER NOT NULL, end INTEGER NOT NULL, events INTEGER NOT NULL DEFAULT 0);
CREATE TABLE ingest_log (uuid TEXT PRIMARY KEY, at INTEGER NOT NULL);         -- kept 7 days
CREATE TABLE session_recordings (session_id TEXT PRIMARY KEY, distinct_id TEXT NOT NULL, start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL, click_count INTEGER NOT NULL DEFAULT 0, keypress_count INTEGER NOT NULL DEFAULT 0,
  console_error_count INTEGER NOT NULL DEFAULT 0, first_url TEXT, size INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE experiments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  feature_flag_key TEXT NOT NULL, metrics TEXT NOT NULL DEFAULT '[]', filters TEXT NOT NULL DEFAULT '[]',
  start_date INTEGER, end_date INTEGER, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE surveys (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
  questions TEXT NOT NULL, appearance TEXT NOT NULL, conditions TEXT, linked_flag_key TEXT,
  enable_partial_responses INTEGER NOT NULL DEFAULT 0, start_date INTEGER, end_date INTEGER,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
```

R2 (`REPLAY`): `replay/<project id>/<session id>/<first ts, 15 digits>-<8 hex>`
= gzip of the JSON array of that request's rrweb events (each with
`windowId` added from `$window_id`), as received (still field-compressed).

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
   100 KB on its own is written straight to the store. `/s/` sends
   `{pid, replay: [meta]}` messages (Session replay).
3. The queue consumer groups messages by project and calls
   `ProjectStore.ingest(events)` and `recordReplay(metas)`; on error it
   retries the messages after 10 seconds; after 10 tries they go to the DLQ.
4. `ingest` writes to the shards, then runs definitions, `$groupidentify`
   and person processing (`protocol.md` section 7) in one head transaction
   ("Event shards"). It returns `{inserted, duplicates}`.

## Queries (`query.ts`)

The owner API posts a query object to `/api/projects/:id/query`; it runs
inside the project's store. Shapes follow PostHog's query schema names so
saved insights read naturally: `TrendsQuery`, `FunnelsQuery`,
`RetentionQuery`, `EventsQuery`.

**Person key.** Every query that counts people maps each event's
`distinct_id` through `person_distinct_ids` at query time (in the head,
"Event shards") to `'p' || person_id`, or `'d' || distinct_id` when it has
no person: an event's current person if it has one, else its distinct
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
`<timestamp>_<uuid>` from `next` (ties broken by uuid), so paging is stable
while events arrive. Each row has the event, its time as ISO, properties and the
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
| `/api/projects/:id` | GET, PATCH, DELETE | PATCH `{name, timezone, retention_days, anonymize_ips, autocapture_opt_out, session_recording}`; DELETE removes the store, its shards and recordings |
| `/api/projects/:id/reset_token` | POST | new `phc_` token; the old one stops working |
| `/api/projects/:id/query` | POST | `{query}`; 400 `invalid_query` |
| `/api/projects/:id/events` | GET | `event`, `cursor`, `limit`, `person_id`, `distinct_id`, `properties` (JSON) |
| `/api/projects/:id/definitions` | GET | event names, property names and types, group types |
| `/api/projects/:id/property_values` | GET | `type=event|person`, `key`: up to 50 distinct values (persons, or the latest 5000 events) |
| `/api/projects/:id/stats` | GET | events, persons, events in 24 h, last event time, database bytes (head + shards), shard count |
| `/api/projects/:id/persons` | GET | `search` (email, name or distinct id), `cursor`; `{results, next, total}` |
| `/api/projects/:id/persons/:uuid` | GET, DELETE | DELETE `?delete_events=1` also deletes the person's events and recordings |
| `/api/projects/:id/insights` | GET, POST | `{name, description, query}` → with `short_id` |
| `/api/projects/:id/insights/:short_id` | GET, PATCH, DELETE | |
| `/api/projects/:id/dashboards` | GET, POST | `{name, description, date_from, pinned}` |
| `/api/projects/:id/dashboards/:id` | GET, PATCH, DELETE | GET includes tiles with their insights |
| `/api/projects/:id/dashboards/:id/tiles` | POST | `{insight_id}` |
| `/api/projects/:id/dashboards/:id/tiles/:insight_id` | DELETE | |
| `/api/projects/:id/feature_flags` | GET, POST | `{key, name, active, filters}`; key `[A-Za-z0-9_-]{1,200}`, unique; variants must sum to 100 |
| `/api/projects/:id/feature_flags/:id` | GET, PATCH, DELETE | each change bumps `version` |
| `/api/projects/:id/session_recordings` | GET | `person_id`, `distinct_id`, `before` (ms, cursor), `limit` (≤200); `{results, next}`; each `{id, distinct_id, start_time, end_time, recording_duration (s), click_count, keypress_count, console_error_count, start_url, size, chunks, person}` |
| `/api/projects/:id/session_recordings/:session` | GET, DELETE | DELETE removes the metadata and the R2 chunks |
| `/api/projects/:id/session_recordings/:session/snapshots` | GET | `{snapshots: [rrweb events]}`, decompressed, time order (up to 64 MB of JSON) |
| `/api/projects/:id/experiments` | GET, POST | POST `{name, description, feature_flag_key, variants?, metrics, filters?}`; creates the flag (off) when missing |
| `/api/projects/:id/experiments/:id` | GET, PATCH, DELETE | PATCH fields, or `{action: "launch"|"stop"}`; DELETE keeps the flag |
| `/api/projects/:id/experiments/:id/results` | GET | Experiments |
| `/api/projects/:id/surveys` | GET, POST | Surveys |
| `/api/projects/:id/surveys/:id` | GET, PATCH, DELETE | PATCH fields, or `{action: "launch"|"stop"|"resume"}` |
| `/api/projects/:id/surveys/:id/results` | GET | Surveys |

Other Worker routes: the SDK routes of `protocol.md`, `/_health`
(`{"ok":true}`), `/app.js`, `/app.css`, `/player.js`, `/player.css`, and every other GET path returns
the app shell (history routing). All app responses carry
`X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

## Screens

Left nav: app name, project switcher, Dashboards, Insights, Events,
Persons, Session replay, Feature flags, Experiments, Surveys, Settings,
Account. Mobile (≤760 px): the
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
  that expand to all properties, and "Load more". With recording on, an
  event with `$session_id` has a ▶ link to its recording.
- **Persons** (`/persons`, `/persons/:uuid`): searchable list with total
  and an "anonymous" tag; person page with properties, distinct ids, first
  and last seen, identified state, recordings, recent events, and "Delete
  person and events".
- **Session replay** (`/replay`, `/replay/:session`): list (person, start,
  duration, clicks, keys, console errors, start URL; newest first, "Load
  more"); recording page with rrweb-player (play, speed, skip inactive,
  full screen), session facts, the session's events with their offset from
  the start, and delete. A session with no full snapshot says so.
- **Experiments** (`/experiments`, `/new`, `/:id`): list with status;
  new-experiment form (name, flag key, variants with splits that must sum
  to 100, metrics editor: conversion funnel steps, event count, or
  property sum); experiment page with Launch / Stop, flag link, exposures,
  and per metric a table (variant, exposures, conversions or total, rate
  or mean, 95% credible interval drawn as a bar, chance to be best, uplift)
  with a "Winner" or "Not significant" tag and the reason.
- **Surveys** (`/surveys`, `/new`, `/:id`, `/:id/edit`): list with status;
  editor (name, popover or API, questions with type, text, optional,
  rating scale and labels, choices, link; display conditions: URL
  contains, triggering event); results page (persons shown, responses,
  dismissed, response rate; per question NPS with promoters, passives and
  detractors and the score distribution, choice bars, or the latest 12 text
  answers) with Edit, Launch / Stop / Resume, Delete.
- **Feature flags** (`/feature_flags`, `/new`, `/:id`): list with release
  summary and an on/off switch; editor with key, description, active,
  condition sets (person property filters and rollout %), and either a
  payload or a variants table (key, rollout %, payload JSON); delete. (The
  API also takes a per-condition `variant` override; the 0.1 editor keeps
  one it finds but does not offer it.)
- **Settings** (`/settings`): project name, time zone, token (copy, reset),
  the snippet for this instance, retention days, discard IPs, autocapture
  off, record sessions, usage (events, persons, last event, database size), other projects
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
- `tests/shards.test.ts`: 600 seeded events over 50 days stored as day
  shards, month shards, and half in the legacy table: nine trends, funnel
  and retention queries and full event paging must agree; purge and person
  deletion across shards.
- `tests/replay.test.ts`: the two `/s/` bodies recorded from posthog-js
  1.450.1 (`tests/fixtures/snapshot-requests.json`) → one recording with 2
  chunks, 10 clicks, 4 key presses; snapshots decompressed (no `cv`, full
  snapshot has a document node); delete; recording-off projects drop data.
- `tests/experiments.test.ts`: `lgamma`, the gamma sampler, Monte Carlo
  vs the closed-form P(B > A) for four Beta pairs, determinism; an
  experiment over 200 persons (exposure gating, a person with two variants
  excluded, funnel / count / sum metrics, winner); the 50-exposure rule;
  survey CRUD, `/api/surveys`, remote config and results from the recorded
  survey events (`tests/fixtures/survey-events.json`).
- `e2e/e2e.ts` (`E2E_EMAIL=... npm run e2e` against `npm run dev`): makes
  a project with recording on, an experiment on a multivariate flag and a
  launched survey; serves a customer page on 127.0.0.1 with the Settings
  snippet (plus `opt_out_useragent_filter: true`); Playwright loads it,
  reads flags (exposure), types into a text and a password field, clicks,
  identifies, triggers and answers the survey popover; `posthog-node`
  captures, identifies, aliases and evaluates a flag; then checks stored
  events, persons, a trend, a funnel, retention, the recording (snapshots
  decompressed, password not present), survey results, experiment
  exposures and conversions, and the web app's screens including the
  replay player.
- Demo: `scripts/demo-setup.mjs <site> <email> <password>` makes the
  "Acme Store" project with 58 days of seeded data, five insights, a
  dashboard and two flags; `scripts/shots.mjs` takes the screenshots.
  `scripts/demo-02.mjs <site> <email> <password> <project>` adds three
  real recordings, an experiment with 640 seeded exposures and an NPS
  survey with seeded answers; `scripts/shots-02.mjs` takes the 0.2
  screenshots.

## Session replay (`replay.ts`)

- `/s/` decodes the body (`protocol.md` 4, 11), groups `$snapshot` events
  by project and `$session_id`, and per session writes one R2 object
  (gzip JSON array) and computes metadata: start and end (min and max
  rrweb timestamp), clicks (type 3, source 2, `data.type` 2), key presses
  (type 3, source 5), console errors (type 6 `rrweb/console@1` at level
  `error`), first URL (first type 4 `href`), size (JSON bytes), 1 chunk.
  Metadata goes on the queue; `recordReplay` upserts it (min start, max
  end, sums, first URL from the earliest chunk).
- Snapshots are read by listing the session's prefix, gunzipping each
  chunk, undoing field compression (`protocol.md` 11) and sorting by
  timestamp.
- Privacy: posthog-js masks inputs by default (`maskAllInputs`); the
  server does not unmask or add anything. Recording is off per project
  until the owner turns it on.
- Retention: the cron expires recordings whose end is older than the
  replay retention and deletes their R2 prefixes; deleting a person (with
  events) or a project deletes theirs.

## Experiments (`experiments.ts`, `shared/stats.ts`)

**Choice: Bayesian.** It answers the question owners ask ("how likely is
B better?") at any time without fixing a sample size in advance, and
reading results early does not invalidate it the way it does a
fixed-horizon frequentist test. PostHog's public docs
(posthog.com/docs/experiments/statistics-bayesian) describe the same kind
of engine: a flat prior, "chance to win", 95% credible intervals, a 95%
threshold and at least 50 exposures per variant; this build keeps those
user-facing rules. The model differs on purpose: instead of a normal
approximation of the relative effect, each variant gets its exact
conjugate posterior (below) and variants are compared by sampling, which
stays correct for small counts and rates near 0 or 1 and gives "probability
to be best" across more than two variants directly. No PostHog code or
`ee/` content is used.

- Exposure: per person key, the first `$feature_flag_called` with
  `$feature_flag` = the experiment's flag key between start and end (or
  now), variant = `$feature_flag_response`. Persons with two different
  valid variants are excluded and counted in `multiple_variant_persons`.
  Optional `filters` (property filters) restrict exposures and metric
  events.
- Metrics, counting only each person's events at or after their exposure
  and up to the end:
  - **Conversion** (`funnel`, 1-10 steps, window default 14 days): a person
    converts when the ordered funnel matcher (Queries, Funnels) reaches the
    last step. Posterior per variant: Beta(1 + conversions, 1 + exposures −
    conversions).
  - **Count** (`count`): events per exposed person. Posterior of the rate:
    Gamma(shape 1 + total events, rate 1 + exposures).
  - **Continuous** (`continuous`, `math_property`): per-person sum of the
    property (0 for exposed persons without events). Posterior of the
    mean: Normal(sample mean, sample sd / √n) (large-sample approximation
    under a flat prior).
- Comparison: 20,000 joint draws from the variants' posteriors with a
  seeded PRNG (mulberry32; seed 42 + metric index), Marsaglia-Tsang gamma
  sampling, Beta via two gammas, Box-Muller normals. Reported per variant:
  posterior mean, 95% credible interval (2.5th and 97.5th percentiles),
  probability to be best (share of draws where it is highest), expected
  loss, and uplift against the first variant (`control`; relative difference of posterior
  means) with its 95% interval.
- Significance: a metric is significant when one variant's probability to
  be best is ≥ 0.95 and every variant has ≥ 50 exposures; otherwise the
  result says why not.
- Check: for two Beta posteriors with integer parameters the sampler's
  P(B > A) is compared with the exact sum
  Σ_{i<α_B} B(α_A+i, β_A+β_B) / ((β_B+i) B(1+i, β_B) B(α_A, β_A)).
- Result: `{status, date_from, date_to, variants: [{key, exposures}],
  multiple_variant_persons, metrics: [{kind, name, significant, winner,
  reason, variants: [{key, exposures, conversions | count | sum,
  conversion_rate | mean, posterior_mean, credible_interval,
  probability_to_be_best, uplift, uplift_interval, expected_loss}]}]}`.

## Surveys (`surveys.ts`)

- Stored per project in the head; ids are UUIDs; question ids are kept or
  generated. Validation: name; type `popover|api|widget|external_survey`;
  1-20 questions of type `open|link|rating|single_choice|multiple_choice`
  with text; rating `scale` 2, 3, 5, 7 or 10 and `display` number or
  emoji; at least two choices for choice questions. `appearance` merges
  over `{whiteLabel: true}`. `conditions` is stored as sent (posthog-js
  reads `url`, `urlMatchType`, `selector`, `events`, `deviceTypes`).
- Status: draft (no `start_date`), running (`start_date`, no `end_date`),
  complete (`end_date`). `/api/surveys` lists running, unarchived surveys.
- Results read the survey's events from every shard (up to 50,000 per
  event name per shard): shown and dismissed (events, distinct persons);
  responses = `survey sent` events, the latest per `$survey_submission_id`
  (else per event); completed = those without `$survey_completed: false`;
  response rate = persons who responded / persons shown. Per question the
  answer is `$survey_response_<id>`, else the legacy name. Rating:
  distribution over the scale (0-10 for 10, else 1-n), average, and for
  0-10 scales NPS = round(100 × (promoters 9-10 − detractors 0-6) /
  answers). Choice: counts per choice (multiple choice counts each
  selection; answers outside the list are added). Open and link: the latest
  100 answers with person and time.

## Limits (0.2)

- 10 GB per project per month (one shard); `retention_days` bounds the
  total. The head (persons, flags, metadata) has its own 10 GB.
- A query's final aggregation runs in the head with a 30-second CPU
  budget; see "Event shards" for memory guidance.
- The token cache can serve a reset or deleted token, or an old
  recording/survey setting, for up to 30 seconds in other isolates.
- Recording chunks are one per request; the snapshots endpoint returns up
  to 64 MB of JSON per recording.
- Flags hash the distinct id, so a visitor's variant can change at
  identify (no experience continuity); such a person is excluded from the
  experiment.
- No local flag evaluation (`/api/feature_flag/local_evaluation`), cohorts,
  actions, HogQL, heatmaps, data warehouse or exports.
