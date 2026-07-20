# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What this is

Take-home + portfolio project: an **ingestion pipeline** for Instagram `#matcha` — Meta Graph API → Postgres metadata → durable assets (S3/local) → cursor-paginated `GET /hashtags`.

**Current state**

- Assignment Tasks 1–12 complete (`docs/superpowers/plans/2026-07-15-hashtag-tracker.md`).
- AWS drivers in-app: `src/queue/sqs.ts`, `S3Storage` in `src/storage/index.ts` (SDK v3 credential chain / ECS task role).
- **Production path shipped in-repo:** `Dockerfile`, `deploy/` (ECS Fargate API + worker, migrate task, stop/start, private RDS SQL helper). Live resource names: `deploy/LIVE.md` (region `ap-south-2`).
- Design: `docs/ENGINEERING.md`. Spec: `docs/superpowers/specs/2026-07-15-hashtag-tracker-design.md`. Human setup: `README.md`, `instructions.md`. Local personal notes (gitignored): `local-notes/`.

## Commands

```bash
# Local
docker compose up -d              # Postgres 16 → postgres://postgres:postgres@localhost:5432/hashtag
npm run db:migrate                # knex migrations + matcha seed
npm run dev:api                   # Express (src/api.ts)
npm run dev:worker                # queue consumer + cron (src/worker.ts)
npm run sync:once                 # one-shot Meta sync
npm run db:sql                    # safe SQL via tsx (src/scripts/sql-query.ts)
npm test                          # vitest (integration needs docker Postgres)
npx vitest run tests/foo.test.ts
npm run typecheck && npm run lint

# Production image / ECS CMD equivalents
npm run build
npm run start:api                 # node dist/api.js
npm run start:worker              # node dist/worker.js
npm run start:migrate             # node dist/db/migrate.js
npm run start:sync-once
npm run start:sql

# AWS helpers (need AWS CLI creds + live stack)
npm run aws:sql                   # SQL against private RDS via ECS
npm run aws:stop                  # scale down / stop RDS for cost
npm run aws:start                 # start RDS + services
npm run aws:start:api             # API only (no Meta worker)
```

## Architecture

Two entry points, one TypeScript codebase:

- **API** (`src/api.ts` → `src/app.ts`) — stateless Express, **DB read only**. `/`, `/health`, `GET /hashtags?limit&cursor` — keyset on `(posted_at, id)`, cursor base64url `{p,i}`, invalid → 400. Limit clamped 1–100.
- **Worker** (`src/worker.ts`) — consumes jobs; node-cron enqueues `SYNC_RECENT_HASHTAG_MEDIA` every 3h; boot may enqueue top/recent. Only worker talks to Meta + storage.

**Sync heart:** `src/services/sync.ts` — fetch pages (default 50/page, 500 cap) → `upsertBatch` per page → upload pending assets. If Meta fetch fails mid-job, still drain pending uploads, then rethrow.

Exactly **two abstractions** (env-selected). Do **not** add repository layers, service interfaces-with-one-impl, or DI containers:

| | Local | AWS |
|---|---|---|
| `Queue` (`QUEUE_DRIVER`) | `LocalQueue` | SQS |
| `Storage` (`STORAGE_DRIVER`) | `./storage/` | S3 |

Load-bearing decisions (`docs/ENGINEERING.md`):

- **Dedupe in DB** — `media.id` = Meta media ID (PK); `INSERT ... ON CONFLICT DO UPDATE` (likes/comments). Idempotent under SQS at-least-once.
- **Assets** — Meta `media_url` expires; `storage_key` null until upload; select `storage_key IS NULL`; one bad asset logs/skips, never fails the batch.
- **Sort** — `posted_at` (IG time), index `(posted_at DESC, id DESC)`.
- **Hashtag ID** cached in `hashtags.meta_hashtag_id` (30 unique searches / 7 days).
- **Meta client** — retry 429/5xx with backoff (3×); 4xx fails immediately.
- **DB** — Knex; for RDS hostnames, TLS is enabled in `src/db/index.ts` (local Docker Postgres does not need TLS). Use `tsx` migrations locally and `node dist/db/migrate.js` (or ECS migrate task) against RDS — one runtime per database.

**Code tour order for agents:** `api.ts`/`worker.ts` → `app.ts` / `sync.ts` → `media-repo` / `meta/client` → `queue` / `storage` → `config` / `bootstrap` / migrations.

## Conventions

- TypeScript `strict: true`, CommonJS, no `any` in `src/`; Knex (no ORM); zod for env + Meta responses.
- TDD for non-trivial logic; integration tests use real docker-compose Postgres.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`).
- Env in `.env` (gitignored); document every var in `.env.example`. Never commit `problem_statement.md` secrets or real tokens.
- Keep `instructions.md` (setup / vars / tradeoffs / ai-usage) accurate when setup changes.
- Prefer small, concrete changes; do not invent new abstraction layers.

## AWS (this repo)

- **App code** already supports `QUEUE_DRIVER=sqs` and `STORAGE_DRIVER=s3`.
- **Infra / ops** live under `deploy/` (task JSON, scripts) and docs (`docs/aws-*.md`). Prefer updating those over one-off undocumented console clicks when changing deploy.
- Prefer AWS MCP if available; otherwise AWS CLI. Verify uncertain API details against docs.
- Prefer IaC (CDK/CloudFormation) for *new* long-lived infra when asked; existing stack is script + task-definition based — do not silently dual-source of truth.
- Resource names: no em dashes; use hyphens.
- Region for live stack: **ap-south-2**. Secrets Manager IDs (names only, never values): `hashtag-tracker/database-url`, `hashtag-tracker/meta-token`.
- Worker uses **task role** for S3/SQS in ECS (no long-lived access keys in the task).

### Secret safety

- Never commit secrets, paste secret **values** into chat, or bake them into images.
- Prefer runtime resolution (ECS task `secrets:`, or `asm-exec` / secrets-manager skill patterns) over `get-secret-value` into agent context.
- Do not call Secrets Manager in ways that dump full secret payloads into logs or transcripts when a resolve-at-runtime path exists.
