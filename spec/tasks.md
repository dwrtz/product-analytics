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
