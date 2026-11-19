# Tasks

Work in this order. Finish each check before the next task.

1. **Set up.** npm package (Node 22+), `wrangler.example.jsonc` and a copy
   as `wrangler.jsonc` from `design.md`, `spekkr.inputs.json`,
   `src/shared`, `src/worker`, `src/ui`, the UI build script and
   `scripts/copy-sdk.mjs`. Check: `npm run dev` serves a page titled
   `app_name` and `/static/array.js` returns posthog-js.
2. **Wire library (`src/shared`).** Body decoding, token rule, timestamp
   rules, distinct-id rules, UUIDv7, flag hash and property matching, date
   ranges and buckets. Check: `tests/vectors.test.ts` passes every vector
   in `test-vectors.json` except the HTTP ones.
3. **Schema and accounts (R1, R2).** D1 migration, sign-up policy, sign
   in/out, sessions, personal API keys, Origin check, projects. Check: the
   first account can sign up and a second cannot; with `ALLOWED_EMAILS`
   only listed emails can.
4. **Capture (R3).** Legacy and v1 routes, CORS, token lookup, error
   codes, normalization, queue producer and consumer, `ProjectStore.ingest`
   with dedupe. Check: the `capture_responses` vectors and an event sent to
   `/i/v0/e` is readable from the store after the queue delivers it.
5. **Persons and groups (R6).** Merge rules, `$set`/`$set_once`/`$unset`,
   illegal ids, personless events, groups. Check: the `persons` scenarios
   in `test-vectors.json` in the store test.
6. **SDK support (R4, R5).** `/flags`, `/decide`, remote config,
   `/static` with version rewrite, stubs. Check: the flag vectors over HTTP
   and posthog-js loads with no failed requests (no 404 for `surveys.js`).
7. **Queries (R7, R9).** Events query with cursor, trends (maths,
   breakdown, compare), funnels (ordered as the UDF, unordered), retention.
   Check: `tests/store.test.ts` numbers on the fixed dataset.
8. **Owner API (R8, R10, R11, R12).** Persons, insights, dashboards,
   flags, definitions, property values, stats, project settings, token
   reset, project delete, cron purge. Check: the HTTP tests.
9. **Web app (R13).** Every screen in `design.md`, desktop and 390 px.
   Check: by hand against the demo project (`scripts/demo-setup.mjs`).
10. **E2E (R14).** `npm run e2e` with the real posthog-js in Chromium and
    posthog-node; screenshots with `scripts/shots.mjs`.
11. **Deploy.** Follow `design.md` ("Deploy") with `ALLOWED_EMAILS` set,
    then point a real site's snippet at it and see events in Events.

0.2 (after 1-11, or on an existing 0.1 build):

12. **Event shards (R15).** `EventShard` class and binding, `eventsql.ts`
    primitives, head registry and `ingest_log`, two-phase trends, funnels,
    retention and events, legacy table as a pseudo-shard, purge and person
    deletion across shards. Check: `tests/shards.test.ts` (day shards,
    month shards and legacy agree) and every earlier test still passes.
13. **Session replay (R16).** R2 binding, D1 `0002_replay.sql`, `/s/`
    handler, queue metadata, `session_recordings`, snapshots API with field
    decompression, remote config `sessionRecording`, retention; then the
    rrweb-player bundle and the Session replay, person and events screens.
    Check: `tests/replay.test.ts` with the recorded fixtures, then a real
    posthog-js recording plays in the UI.
14. **Experiments (R17).** `shared/stats.ts`, experiment CRUD creating the
    multivariate flag, launch and stop, exposure and metrics, results and
    screens. Check: `tests/experiments.test.ts` (sampler vs closed form,
    the 200-person experiment).
15. **Surveys (R18).** Survey CRUD, `/api/surveys`, remote config
    `surveys`, results and screens. Check: the survey tests with the
    recorded events, and a survey shown and answered by posthog-js in a
    browser.
16. **E2E and screenshots.** `npm run e2e` (now with replay, survey and
    experiment checks); `scripts/demo-02.mjs` and `scripts/shots-02.mjs`.
17. **Upgrade a deployment.** `design.md` "Upgrading 0.1 → 0.2".

0.3 (after 1-17):

18. **Actions (R19).** `shared/elements.ts` (chain parser, selectors),
    `shared/actions.ts`, SQL step compiler plus shard JS pre-pass,
    `ActionsNode` in trends, funnels, retention and experiments; Actions
    screens. Check: selector and action tests.
19. **Cohorts (R20).** `worker/cohorts.ts`, tables, calculation (save,
    hourly cron, on demand), static input, cohort filters everywhere,
    cohort flag conditions; Cohort screens. Check: cohort tests.
20. **Streaming funnels and paged surveys (R26).** Two-pass funnels in
    person batches; survey results by cursor. Check: batch size 3 equals
    one pass.
21. **SQL (R22).** `worker/sqlquery.ts`, `/sql`, HogQLQuery; SQL screen.
    Check: SQL tests.
22. **Local evaluation and continuity (R23, R24).** Definitions endpoints
    with ETag; hash key overrides from `$anon_distinct_id`. Check:
    continuity test, HTTP 401/304 tests, posthog-node in the e2e.
23. **Survey targeting (R25).** Hidden targeting flags, conditions,
    iterations, partial merge; editor and results. Check: survey tests.
24. **Replay settings and heatmaps (R21, R26).** D1 `0003_v03.sql`,
    remote config mapping, paged snapshots, console/network panels,
    heatmap and scroll APIs and screen. Check: the tests, then
    `conform03/` against `wrangler dev`.
25. **E2E and screenshots.** `npm run e2e` (49 checks);
    `scripts/shots-03.mjs`.
26. **Upgrade a deployment.** Apply `0003_v03.sql`, deploy (adds the
    hourly cron). Existing data needs no migration.

0.4 (after 1-26):

27. **Cold tier (R27).** `worker/cold.ts` (records, `compileCold`,
    `buildColdQuery`, `basinSql`), `prepareSelect` shared from
    `sqlquery.ts`, `source: "cold"` on `/sql`, `cold_tier` in
    `/api/config`, the source picker on the SQL screen. Check:
    `tests/cold.test.ts`.
28. **Basin setup and deploy.** Bucket with Basin Catalog, stream (schema
    in `design.md` "Cold tier"), the one token, sink, pipeline, catalog
    maintenance; `COLD_STREAM` binding, `BASIN_*` vars and the
    `BASIN_TOKEN` secret (keep secrets on later uploads). Check: send
    events, wait about two minutes, and a cold SQL query returns them
    while an event older than the retention period is excluded.
