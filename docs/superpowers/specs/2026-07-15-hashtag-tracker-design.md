# Instagram Hashtag Tracker — Design Spec

**Date:** 2026-07-15
**Status:** Approved for implementation

## 1. Problem

Build a scalable ingestion pipeline that tracks the `matcha` Instagram hashtag: fetch top and recent media from the Meta Graph API (paginated, up to 500 items per sync), store metadata in Postgres, copy media assets to durable storage, avoid duplicates, and expose one paginated read API. Recent media syncs every 3 hours.

Full assignment: `problem_statement.md`.

## 2. Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| AWS scope | Real S3 + real SQS, in-process node-cron | Uses the available AWS account for the parts that matter (durable storage, decoupled jobs) without EventBridge/Lambda deploy complexity a reviewer can't run. Local drivers exist for both, so reviewers without AWS run everything with `docker compose` + env flags. |
| DB layer | Knex (queries + migrations) | One dependency covers both. Universally understood, minimal config for a 2-table schema. |
| Read API pagination | Cursor-based (keyset on `posted_at, id`) | Feed is append-heavy; offset pagination shifts under inserts and degrades on deep pages. |
| Worker model | Separate entry point (`api.ts` / `worker.ts`), shared codebase | SQS consumers scale independently of the API in production; costs ~zero extra code here. |
| Dedupe | Meta media ID as `media.id` PK + `ON CONFLICT DO UPDATE` | The natural key IS the dedupe mechanism — enforced by the DB, not application checks. Re-syncs refresh like/comment counts instead of erroring. |
| Methodology | TDD (red → green → refactor) for all non-trivial logic | Requested; also the sync/dedupe/cursor logic is exactly the kind of code that rots without tests. |

## 3. Architecture

Two processes, one TypeScript codebase:

```
src/
  api.ts          Express server: GET /hashtags, GET /health
  worker.ts       SQS/local queue consumer + node-cron (enqueue SYNC_RECENT every 3h)
  config.ts       zod-validated env config; fail fast at boot
  db/             knex instance; migrations/ ; seeds/ (matcha hashtag)
  meta/           Graph API client: hashtag search, top_media, recent_media,
                  cursor pagination, retry with backoff
  queue/          Queue interface → SqsQueue | LocalQueue  (QUEUE_DRIVER env)
  storage/        Storage interface → S3Storage | LocalStorage (STORAGE_DRIVER env)
  services/
    sync.ts       orchestrates: fetch pages → upsert batch → upload assets → mark synced
    media-repo.ts DB access for media (upsert, keyset page query)
```

Queue and Storage are the only abstractions — one small interface each, two implementations, selected by env var. Nothing else gets an interface (YAGNI).

### Job types

- `SYNC_TOP_HASHTAG_MEDIA` — enqueued once on first boot (when `last_synced_at` is null)
- `SYNC_RECENT_HASHTAG_MEDIA` — enqueued by cron `0 */3 * * *`, and once at worker start

Payload: `{ hashtag: string, hashtagId: string }`.

## 4. Database schema

### `hashtags`
| column | type | notes |
|---|---|---|
| id | serial PK | |
| name | text UNIQUE | seeded: `matcha` |
| meta_hashtag_id | text | resolved via `ig_hashtag_search`, cached here |
| last_synced_at | timestamptz nullable | |
| created_at / updated_at | timestamptz | |

### `media`
| column | type | notes |
|---|---|---|
| id | text PK | **Meta's media ID — natural key, dedupe boundary** |
| hashtag_id | int FK → hashtags | |
| caption | text nullable | |
| media_type | text | IMAGE / VIDEO / CAROUSEL_ALBUM |
| permalink | text | |
| media_url | text nullable | Meta's URL — expires; kept for provenance |
| storage_key | text nullable | our S3/local copy; null until asset uploaded |
| like_count / comments_count | int | refreshed on re-sync |
| posted_at | timestamptz | Meta `timestamp`; feed sort key |
| source | text | `top` \| `recent` |
| created_at / updated_at | timestamptz | |

Index: `(posted_at DESC, id DESC)` for keyset pagination.

**Left out, and why** (also goes in instructions.md tradeoffs):
- Owner/user fields — hashtag endpoints don't return them (privacy restriction in the Graph API).
- Carousel children — single-level records are enough for the read API.
- Raw payload JSONB — speculative; add if a future consumer needs unmapped fields.

## 5. Data flow (sync job)

1. Worker receives job → resolve `hashtagId` (cached in `hashtags` row; call `ig_hashtag_search` only if missing).
2. Meta client fetches pages via `paging.cursors.after`, `limit=50`, until **500 items** or no next page.
3. **Per page**: batch upsert metadata (`ON CONFLICT (id) DO UPDATE` counts + `updated_at`). Partial progress survives a crash; re-delivery is idempotent.
4. **Asset upload pass**: select rows for this hashtag with `storage_key IS NULL AND media_url IS NOT NULL`; download → stream to storage as `media/{mediaId}.{ext}`; concurrency limit 5; update `storage_key` per success.
5. Update `hashtags.last_synced_at`.

## 6. Read API

`GET /hashtags?limit=20&cursor=<opaque>`

- Descending `posted_at` (tie-break `id`), keyset: `WHERE (posted_at, id) < (?, ?)`.
- Cursor = base64url JSON `{ p: posted_at_iso, i: id }`. Invalid cursor → 400.
- `limit` clamped 1–100.
- Response: `{ data: MediaItem[], nextCursor: string | null }`. `nextCursor` null on last page.

## 7. Error handling

- **Meta API**: retry 429/5xx with exponential backoff (3 attempts) inside the client. 4xx (expired token, bad request) → fail job with a clear log; no retry storm.
- **Job level**: throw → SQS visibility timeout re-delivers (maxReceiveCount left default; DLQ noted as tradeoff, not built). LocalQueue mirrors with a bounded retry count.
- **Per-asset**: one failed download logs and skips; `storage_key` stays null; next sync retries. One bad asset never fails the batch.
- **Boot**: zod validates env; missing/invalid → process exits with named missing vars.
- **API**: central Express error handler; JSON errors; no stack traces in responses.

## 8. Testing (TDD)

Red → green → refactor for every non-trivial unit. Vitest.

- **Unit**: cursor encode/decode (round-trip, tampered input), Meta client pagination + retry (mocked fetch), sync service orchestration (mocked repo/storage/client), config validation.
- **Integration** (real Postgres via docker compose): migrations run clean, upsert dedupe (insert twice → one row, counts updated), keyset pagination query (ordering, boundaries, empty page).
- **API**: supertest against the Express app with a test DB — happy path, bad cursor, limit clamping.
- **Smoke**: `npm run sync:once` triggers a real sync end-to-end (manual, documented in instructions.md).

Coverage target: the logic, not a percentage. No E2E framework.

## 9. Code standards

- TypeScript strict mode; ESLint + Prettier; no `any` in src.
- Small focused modules; dependency injection by constructor/params (no DI framework).
- Conventional commits; each TDD cycle commits test + implementation together.
- `.env.example` documents every variable; secrets never committed.

## 10. Deliverables

1. Working code (this repo, shared with the three reviewers).
2. `instructions.md` — `setup`, `vars`, `tradeoffs`, `ai-usage` sections.
3. `docs/ENGINEERING.md` — staff-level engineering doc: system overview + diagram, tech stack rationale, Meta Graph API notes (hashtag search flow, pagination, rate limits, token/permission model, URL expiry), dedupe strategy, scalability path (DLQ, multi-hashtag, Lambda consumers, CDN), tradeoffs and what we'd do with more time.
4. `ai-usage/` — exported chat history (assignment prioritizes submissions that include it).
5. `docker-compose.yml` (Postgres), migrations, seeds.

## 11. Out of scope (recorded as tradeoffs, not built)

DLQ, multi-hashtag admin API, image resizing/CDN, metrics/observability stack, EventBridge/Lambda deployment, carousel children, webhook-based ingestion.
