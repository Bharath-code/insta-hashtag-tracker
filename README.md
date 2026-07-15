# insta-hashtag-track

Ingestion pipeline tracking the Instagram `matcha` hashtag: fetches top/recent media from the Meta Graph API, stores metadata in Postgres, copies assets to S3 or local storage, dedupes, and serves one cursor-paginated `GET /hashtags` API.

## Quick start

```bash
docker compose up -d       # Postgres 16
cp .env.example .env       # fill META_ACCESS_TOKEN / META_USER_ID
npm install
npm run db:migrate         # migrations + matcha seed
npm run dev:worker         # sync worker (top media on first run, recent every 3h)
npm run dev:api            # API on :3000
curl 'http://localhost:3000/hashtags?limit=10'
```

One-off sync: `npm run sync:once`. Tests: `npm test` (integration tests need the docker Postgres). Full setup, env var reference, tradeoffs, and AI-usage notes: [`instructions.md`](instructions.md).

## Architecture

Two entry points, one TypeScript codebase:

- **API** (`src/api.ts`) — stateless Express, reads the DB only. `GET /hashtags?limit&cursor` returns media newest-first via keyset pagination with an opaque base64url cursor.
- **Worker** (`src/worker.ts`) — consumes sync jobs from the queue; node-cron enqueues a recent-media sync every 3h. Only the worker talks to Meta and storage.

Two swappable drivers, chosen by env var:

| Abstraction | Local (default) | AWS |
|---|---|---|
| `Queue` (`QUEUE_DRIVER`) | in-memory `LocalQueue` | SQS (`src/queue/sqs.ts`) |
| `Storage` (`STORAGE_DRIVER`) | `./storage/` files | S3 (`src/storage/index.ts`) |

AWS drivers use the AWS SDK v3 standard credential chain — no infra provisioning is part of this repo.

Key decisions (full reasoning in [`docs/ENGINEERING.md`](docs/ENGINEERING.md)):

- **Dedupe in the DB** — Meta's media ID is the primary key; ingestion is `INSERT ... ON CONFLICT DO UPDATE`, making the pipeline idempotent under at-least-once queue redelivery.
- **Assets copied off Meta's CDN** — `media_url` expires; `storage_key` stays null until upload succeeds, so uploads are resumable.
- **`posted_at` is the feed sort key**, indexed `(posted_at DESC, id DESC)` to match the keyset query exactly.
- **Hashtag ID cached** — Meta allows only 30 unique hashtag searches per 7 days.

## Docs

- [`instructions.md`](instructions.md) — setup, env vars, tradeoffs, AI usage
- [`docs/ENGINEERING.md`](docs/ENGINEERING.md) — design rationale
- [`docs/superpowers/plans/2026-07-15-hashtag-tracker.md`](docs/superpowers/plans/2026-07-15-hashtag-tracker.md) — implementation plan (Tasks 1–12, all complete)
