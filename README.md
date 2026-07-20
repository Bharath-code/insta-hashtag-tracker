# insta-hashtag-track

Ingestion pipeline for the Instagram `matcha` hashtag: fetch top/recent media from the Meta Graph API, store metadata in Postgres, copy assets to S3 or local storage, dedupe, and serve one cursor-paginated `GET /hashtags` API.

**Status:** assignment implementation complete, plus a **live AWS deploy** path (ECS Fargate, RDS, SQS, S3). Local default needs only Docker Postgres and a Meta token.

## Quick start (local)

```bash
docker compose up -d       # Postgres 16
cp .env.example .env       # fill META_ACCESS_TOKEN / META_USER_ID
npm install
npm run db:migrate         # migrations + matcha seed
npm run dev:worker         # sync worker (top on first run, recent every 3h)
npm run dev:api            # API on :3000
curl 'http://localhost:3000/hashtags?limit=10'
```

| Command | Purpose |
|---|---|
| `npm run sync:once` | One-shot end-to-end sync against Meta |
| `npm test` | Vitest (integration tests need docker Postgres) |
| `npm run typecheck && npm run lint` | CI-style checks |
| `npm run build` | Compile to `dist/` for Docker / production |

Full setup, env vars, tradeoffs, and AI-usage notes: [`instructions.md`](instructions.md).

## Architecture

Two entry points, one TypeScript codebase:

- **API** (`src/api.ts` / `src/app.ts`) — stateless Express, **reads the DB only**. Routes: `/`, `/health`, `GET /hashtags?limit&cursor` (keyset pagination, opaque base64url cursor).
- **Worker** (`src/worker.ts`) — queue consumer + node-cron (recent sync every 3h). **Only the worker** talks to Meta and storage. Flow: fetch pages → upsert per page → upload pending assets (`storage_key IS NULL`).

Two swappable drivers (env-selected):

| Abstraction | Local (default) | AWS |
|---|---|---|
| `Queue` (`QUEUE_DRIVER`) | in-memory `LocalQueue` | SQS (`src/queue/sqs.ts`) |
| `Storage` (`STORAGE_DRIVER`) | `./storage/` files | S3 (`src/storage/index.ts`) |

Key decisions (full reasoning in [`docs/ENGINEERING.md`](docs/ENGINEERING.md)):

- **Dedupe in the DB** — Meta media ID is the PK; `INSERT ... ON CONFLICT DO UPDATE` keeps the pipeline **idempotent** under SQS at-least-once redelivery.
- **Assets copied off Meta’s CDN** — `media_url` expires; nullable `storage_key` makes uploads resumable.
- **`posted_at` is the feed sort key**, indexed `(posted_at DESC, id DESC)` for keyset pagination.
- **Hashtag ID cached** — Meta allows only 30 unique hashtag searches per 7 days.
- **Meta retries** — 429/5xx with backoff; 4xx fails immediately (no token retry storm).

## Docker (production image)

Same image for API, worker, and one-off migrate/SQL tasks:

```bash
docker build -t hashtag-tracker:local .
docker run --rm --env-file .env hashtag-tracker:local node dist/db/migrate.js
docker run --rm -p 3000:3000 --env-file .env hashtag-tracker:local          # API
docker run --rm --env-file .env hashtag-tracker:local node dist/worker.js    # worker
```

| Command | Purpose |
|---|---|
| `npm run start:api` | `node dist/api.js` |
| `npm run start:worker` | `node dist/worker.js` |
| `npm run start:migrate` | `node dist/db/migrate.js` |
| `npm run start:sync-once` | `node dist/scripts/sync-once.js` |
| `npm run start:sql` / `db:sql` | Safe one-off SQL runner (`src/scripts/sql-query.ts`) |

## AWS (portfolio deploy)

Production shape: **ECS Fargate** (API + worker), **ALB**, private **RDS Postgres**, **SQS**, **S3**, **Secrets Manager**, region **`ap-south-2`**.

| Resource | Doc / tool |
|---|---|
| Deploy steps | [`deploy/README.md`](deploy/README.md) |
| Live ALB + resource names | [`deploy/LIVE.md`](deploy/LIVE.md) |
| Cost: stop / start demo | [`deploy/stop-start-demo.md`](deploy/stop-start-demo.md) · `npm run aws:stop` / `aws:start` |
| Query private RDS | [`deploy/aws-sql.sh`](deploy/aws-sql.sh) · `npm run aws:sql` |
| Console map | [`docs/aws-console-and-query.md`](docs/aws-console-and-query.md) |
| Portfolio rationale | [`docs/aws-portfolio-deploy.md`](docs/aws-portfolio-deploy.md) |

App drivers use the AWS SDK v3 credential chain (or the ECS **task role** in production). Infra scripts and task JSON live under `deploy/` — they are part of this repo; secrets never are (`.env` and `problem_statement.md` are gitignored).

## Docs

- [`instructions.md`](instructions.md) — setup, env vars, tradeoffs, AI usage
- [`docs/ENGINEERING.md`](docs/ENGINEERING.md) — design rationale
- [`docs/aws-portfolio-deploy.md`](docs/aws-portfolio-deploy.md) — full AWS deploy for portfolio / hiring
- [`docs/aws-container-deploy.md`](docs/aws-container-deploy.md) — container / networking guide
- [`docs/aws-console-and-query.md`](docs/aws-console-and-query.md) — find RDS/ECS/S3 + how to query
- [`docs/worker-cron-and-s3-timing.md`](docs/worker-cron-and-s3-timing.md) — 3h cron vs always-on worker vs S3 bursts
- [`docs/db-access.md`](docs/db-access.md) — where data lives after sync
- [`deploy/README.md`](deploy/README.md) · [`deploy/LIVE.md`](deploy/LIVE.md)
- [`docs/superpowers/plans/2026-07-15-hashtag-tracker.md`](docs/superpowers/plans/2026-07-15-hashtag-tracker.md) — implementation plan (Tasks 1–12 complete)
- [`CLAUDE.md`](CLAUDE.md) · [`AGENTS.md`](AGENTS.md) — guidance for coding agents
