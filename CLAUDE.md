# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Take-home assignment (`problem_statement.md`): an ingestion pipeline tracking the Instagram `matcha` hashtag — fetch top/recent media from the Meta Graph API, store metadata in Postgres, copy assets to S3/local storage, dedupe, and serve one cursor-paginated `GET /hashtags` API.

**Current state: design docs only, no code yet.** Implementation follows the task-by-task plan in `docs/superpowers/plans/2026-07-15-hashtag-tracker.md` (Tasks 1–12, checkbox-tracked, each with failing test → implementation → commit). Design rationale lives in `docs/ENGINEERING.md`; spec in `docs/superpowers/specs/2026-07-15-hashtag-tracker-design.md`. Update the plan's checkboxes as tasks complete.

## Commands (once scaffolded — Task 1)

```bash
docker compose up -d          # Postgres 16 at postgres://postgres:postgres@localhost:5432/hashtag
npm run db:migrate            # knex migrations + matcha seed
npm run dev:api               # Express API (src/api.ts)
npm run dev:worker            # queue consumer + cron (src/worker.ts)
npm run sync:once             # one-shot end-to-end sync against Meta
npm test                      # vitest run (integration tests need docker compose up)
npx vitest run tests/foo.test.ts   # single test file
npm run typecheck && npm run lint
```

## Architecture

Two entry points, one TypeScript codebase:

- **API** (`src/api.ts`) — stateless Express, reads DB only. `GET /hashtags?limit&cursor` returns media newest-`posted_at`-first via keyset pagination (`WHERE (posted_at, id) < (cursor)`), cursor is base64url `{p, i}` and opaque to clients; invalid cursor → 400.
- **Worker** (`src/worker.ts`) — consumes sync jobs from the queue; node-cron enqueues `SYNC_RECENT_HASHTAG_MEDIA` every 3h. Only the worker talks to Meta and storage. Sync flow: fetch pages (50/page, 500-item cap) → upsert per page → upload pending assets.

Exactly **two abstractions**, each with an AWS and a local driver chosen by env var: `Queue` (SQS / in-memory `LocalQueue`, `QUEUE_DRIVER`) and `Storage` (S3 / `./storage/` files, `STORAGE_DRIVER`). Do not add more interfaces, repository patterns, or DI containers — the docs are explicit that everything else stays concrete.

Load-bearing decisions (see `docs/ENGINEERING.md` for full reasoning):

- **Dedupe lives in the DB**: Meta's media ID is `media.id` (PK); ingestion is `INSERT ... ON CONFLICT (id) DO UPDATE` refreshing like/comment counts. No read-before-write checks. This makes the whole pipeline idempotent under SQS at-least-once redelivery.
- **`media_url` (Meta CDN) expires** — that's why assets are copied to storage. `storage_key` is nullable until upload succeeds; the upload pass selects `storage_key IS NULL`, making uploads resumable. One failed asset logs and skips, never fails the batch.
- **`posted_at` (Meta's timestamp) is the feed sort key**, not our ingestion time. Index `(posted_at DESC, id DESC)` matches the keyset query exactly.
- **Hashtag ID is resolved once and cached** in `hashtags.meta_hashtag_id` — Meta allows only 30 unique hashtag searches per 7 days.
- **Meta client retries 429/5xx** with exponential backoff (3 attempts); 4xx fails immediately (retrying an expired token is a retry storm).

## Conventions

- TypeScript `strict: true`, CommonJS, no `any` in `src/`; Knex for migrations + queries (no ORM); zod validates env at boot and Meta responses.
- TDD: failing test first for every non-trivial unit; tests target logic, not coverage numbers. Integration tests use the real docker-compose Postgres.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Env in `.env` (gitignored), every var documented in `.env.example`. Meta credentials are in `problem_statement.md` — never commit them elsewhere.
- Deliverables include a root `instructions.md` with `setup` / `vars` / `tradeoffs` / `ai-usage` sections (Task 12) — keep it current when setup steps change.
