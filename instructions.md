# instructions

## setup

1. `docker compose up -d` — starts Postgres 16 on :5432
2. `cp .env.example .env` — fill `META_ACCESS_TOKEN` (and AWS vars if using sqs/s3 drivers)
3. `npm install`
4. `npm run db:migrate` — applies migrations and seeds the `matcha` hashtag
5. `npm run dev:worker` — starts the sync worker (syncs top media on first run, recent media every 3h)
6. `npm run dev:api` — starts the API on :3000
7. `curl 'http://localhost:3000/hashtags?limit=10'`

One-off sync without the worker: `npm run sync:once`
Tests: `npm test` (integration tests need the docker Postgres running)

## vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| DATABASE_URL | yes | — | Postgres connection string |
| META_ACCESS_TOKEN | yes | — | Instagram page token |
| META_USER_ID | yes | — | Instagram business account id |
| META_API_BASE | no | https://graph.facebook.com/v24.0 | Graph API base URL |
| QUEUE_DRIVER | no | local | `local` or `sqs` |
| SQS_QUEUE_URL | if sqs | — | SQS queue URL |
| STORAGE_DRIVER | no | local | `local` or `s3` |
| S3_BUCKET / AWS_REGION | if s3 | — | S3 target |
| STORAGE_LOCAL_DIR | no | ./storage | Local asset directory |
| PORT | no | 3000 | API port |
| SYNC_MAX_ITEMS | no | 500 | Per-sync media cap |
| META_PAGE_SIZE | no | 50 | Graph API page size |

AWS drivers use the standard AWS SDK credential chain (env vars / `~/.aws`).

## tradeoffs

See `docs/ENGINEERING.md` §10 for the full ledger. Highlights:
- node-cron in the worker instead of EventBridge — keeps the repo runnable with `npm run dev:worker`; the cron only calls `queue.enqueue()`, so EventBridge swaps in at one call site.
- No DLQ — failed jobs retry 3× (LocalQueue) or via SQS visibility timeout, then drop with a logged error.
- Carousel children flattened to one record; no owner fields (the hashtag API doesn't return them).
- Asset extension inferred from content-type (jpg/mp4) rather than parsing URLs.

## ai-usage

- **Tools:** Claude Code (Sonnet 5) end to end.
- **Used for:** brainstorming the design (spec in `docs/superpowers/specs/`), writing the implementation plan (`docs/superpowers/plans/`), generating code and tests task-by-task via TDD, drafting `docs/ENGINEERING.md`.
- **Reviewed/tested/written myself:** approved every design decision (AWS scope, Knex, cursor pagination, worker split); reviewed each task's diff before commit; ran the unit/mocked test suite and typecheck/lint after every task. Integration tests (real Postgres) and the live Meta smoke test (`npm run sync:once` + API pagination) were written and wired up but could not be executed in this build environment (no Docker/Postgres available) — run `npm test` locally with `docker compose up -d` to exercise them before relying on this build.
- **Chat history:** exported in `ai-usage/`.
