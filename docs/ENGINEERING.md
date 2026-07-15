# Engineering Doc — Instagram Hashtag Tracker

How this system is designed and built, the reasoning behind each decision, and what we'd do differently at scale.

**Status:** living document — updated as the build progresses.

---

## 1. System overview

An ingestion pipeline that tracks the `matcha` Instagram hashtag: fetches top and recent media from the Meta Graph API, stores metadata in Postgres, copies media assets into durable storage (S3), and serves stored media through one cursor-paginated read API.

```
                ┌──────────────┐  every 3h   ┌─────────┐
                │ node-cron    │────────────▶│  Queue   │  SQS (or local driver)
                │ (in worker)  │  enqueue    │          │
                └──────────────┘             └────┬─────┘
                                                  │ consume
                                                  ▼
┌───────────┐   pages (cursor)   ┌──────────────────────────┐
│ Meta      │◀──────────────────▶│  Worker (sync service)   │
│ Graph API │                    │  fetch → upsert → upload │
└───────────┘                    └────────┬────────┬────────┘
                                          │        │ assets
                                     upsert        ▼
                                          │   ┌─────────┐
                                          ▼   │ Storage │  S3 (or local driver)
                                   ┌──────────┴┐────────┘
                                   │ Postgres  │
                                   └─────┬─────┘
                                         │ keyset query
                                         ▼
                                  ┌─────────────┐   GET /hashtags
                                  │ Express API │◀───────────────  clients
                                  └─────────────┘
```

Two processes, one codebase:

- **API** (`src/api.ts`) — stateless Express server. Only reads the DB.
- **Worker** (`src/worker.ts`) — queue consumer plus the cron that enqueues sync jobs. Only it talks to Meta and storage.

Separating them is deliberate: ingestion is bursty (500 downloads in a sync window) and must never affect read-API latency. In production these scale independently — more workers when the queue backs up, more API replicas behind a load balancer for read traffic. Locally, both start from one repo with two npm scripts.

## 2. Tech stack and why

| Layer | Choice | Rationale |
|---|---|---|
| Runtime / language | Node 20+, TypeScript strict | Assignment requirement; strict mode catches whole classes of bugs at compile time. |
| Web framework | Express | Assignment requirement. Kept thin — routes delegate to services. |
| Database | Postgres | Assignment requirement. Also the right tool: the dedupe constraint and keyset pagination are native Postgres features, so correctness lives in the DB, not application code. |
| DB access | Knex | One dependency covers migrations *and* query building. For a 2-table schema, a full ORM (Prisma/Drizzle) adds config surface without paying for itself. Raw SQL stays visible where it matters (upserts, keyset). |
| Queue | AWS SQS, `LocalQueue` fallback | Real decoupled job queue with at-least-once delivery and visibility-timeout retries for free. The in-memory driver keeps the repo runnable without AWS. |
| Storage | AWS S3, `LocalStorage` fallback | Meta media URLs expire (see §4); S3 gives us durable copies. Local driver writes to `./storage/` for reviewers. |
| Scheduling | node-cron inside the worker | EventBridge + Lambda is the production shape, but it makes the repo un-runnable without a deploy. The cron's only job is `enqueue()` — swapping it for EventBridge later touches one file. |
| Validation | zod | Env config validated at boot (fail fast, named missing vars); Meta API responses parsed, not trusted. |
| Testing | Vitest + supertest | Fast, TS-native, one test runner for unit/integration/API layers. |
| Lint/format | ESLint + Prettier | Standard; enforced, not debated. |

### The two abstractions (and why only two)

`Queue` and `Storage` are the only interfaces in the codebase — each with an AWS and a local implementation selected by env var (`QUEUE_DRIVER`, `STORAGE_DRIVER`). These earn their existence because the assignment explicitly requires local↔AWS swappability, and both have genuinely different backends.

Nothing else is abstracted. No repository-pattern-over-ORM, no service interfaces with one implementation, no DI container. Premature abstraction is the most common failure mode in take-home assignments; every interface must justify a second implementation.

## 3. Data model

### `hashtags`
`id`, `name` (unique, seeded `matcha`), `meta_hashtag_id` (cached — see §4), `last_synced_at`, timestamps.

### `media`
The interesting decisions:

- **`id` is Meta's media ID and the primary key.** This is the entire dedupe strategy — see §5.
- **`media_url` AND `storage_key` both stored.** `media_url` is Meta's CDN URL, which expires; it's kept for provenance and for the asset-upload pass. `storage_key` points at our durable copy and is what a real client would render. Nullable until upload succeeds — which also makes asset uploads retryable (see §6).
- **`posted_at` (Meta's `timestamp`) is the feed sort key**, not our `created_at`. "Descending creation time" should mean when the post was created on Instagram, not when we happened to ingest it.
- **`source` (`top` | `recent`)** records which endpoint produced the row. Cheap, and useful for debugging why a media item appears.
- **`like_count` / `comments_count`** are refreshed on every re-sync via the upsert.
- Index on `(posted_at DESC, id DESC)` — exactly the keyset pagination access path, nothing else.

### What we deliberately left out

| Field | Why not |
|---|---|
| Owner / username | Meta's hashtag endpoints don't return owner data — a privacy restriction of the API, not our choice. |
| Carousel children | `CAROUSEL_ALBUM` items are stored as one record. The read API doesn't need children; adding a `media_children` table is mechanical if it ever does. |
| Raw payload JSONB | Speculative. If a future consumer needs unmapped fields we add a column then; until then it's dead weight on every row. |

## 4. The Meta Graph API — what you need to know

Everything below is why the ingestion code looks the way it does.

- **Auth model**: requests use a page access token plus the Instagram Business account ID (`user_id`). Hashtag endpoints require the account to have the right permissions (`instagram_basic`, hashtag search approval).
- **Hashtag ID resolution**: `GET /ig_hashtag_search?user_id&q=matcha` returns a numeric hashtag ID. Meta limits an account to **30 unique hashtag queries per 7 days**, so we resolve once and cache the ID in `hashtags.meta_hashtag_id` forever. Re-querying per sync would burn the quota for nothing.
- **Two media endpoints**: `/{hashtag_id}/top_media` (popular; fetched once at bootstrap) and `/{hashtag_id}/recent_media` (last 24h of posts; fetched every 3h). Both return the same shape.
- **Pagination**: standard Graph API cursors — `paging.cursors.after` + `paging.next`. We follow `after` with `limit=50` per page until we hit the 500-item sync cap or run out of pages. The cap is a guardrail: a viral hashtag can page effectively forever.
- **`media_url` expires.** Meta's CDN URLs are signed and time-limited. This is the single most important API quirk in the design — it's *why* the asset pipeline exists. Store the URL alone and your data rots in days.
- **Not all media have `media_url`**: some videos and copyright-restricted items omit it. The schema allows null and the upload pass skips them.
- **No owner data** on hashtag endpoints (privacy). Don't design a schema expecting it.
- **Rate limits**: Graph API enforces per-app and per-user call budgets (BUC). Our client retries 429/5xx with exponential backoff (3 attempts) and treats 4xx (expired token, permission errors) as immediate job failure — retrying an expired token is a retry storm, not resilience.

## 5. Deduplication

**The database enforces it; the application merely cooperates.**

Meta's media ID is globally unique and stable, so it becomes `media.id` (PK). Ingestion writes with:

```sql
INSERT INTO media (...) VALUES (...)
ON CONFLICT (id) DO UPDATE
  SET like_count = EXCLUDED.like_count,
      comments_count = EXCLUDED.comments_count,
      updated_at = now();
```

Consequences, all intentional:

- A media item appearing in both `top_media` and `recent_media`, or across multiple syncs, produces **one row** — no read-before-write race, no application-level "does this exist?" check that breaks under concurrent workers.
- Re-syncs are **free metric refreshes**: like/comment counts stay current.
- The whole pipeline becomes **idempotent**: SQS is at-least-once, so a redelivered job simply re-upserts the same rows and re-skips already-uploaded assets. Idempotency is the correct response to at-least-once delivery — deduplicating deliveries is fighting the queue's semantics.

## 6. Failure model

Designed around one principle: **any step can die mid-way and a retry finishes the job.**

- **Per-page upserts** — a 500-item sync that crashes at item 300 has persisted 6 pages; redelivery re-fetches (cheap) and re-upserts (idempotent).
- **Asset uploads are resumable** — the upload pass selects `storage_key IS NULL`, so completed uploads are never redone and failed ones are retried on the next sync. One bad asset logs and skips; it never fails the batch.
- **Job retries** — worker lets exceptions propagate; SQS visibility timeout redelivers. LocalQueue mirrors with a bounded retry count.
- **Boot-time config validation** — zod parses env at startup; the process refuses to start with missing/invalid vars rather than failing at 3am mid-sync.
- **API errors** — central Express error handler, JSON error bodies, no stack traces leaked.

## 7. Read API design

`GET /hashtags?limit=20&cursor=<opaque>` — media, newest `posted_at` first.

**Keyset (cursor) pagination, not offset.** Two reasons:

1. **Stability under inserts.** This feed grows every 3 hours. With offset pagination, new rows shift every page boundary — clients see duplicates or gaps. A keyset cursor (`WHERE (posted_at, id) < (last_seen)`) is anchored to a row, not a position.
2. **Performance.** `OFFSET 10000` scans and discards 10k rows; keyset seeks the index directly. O(page) instead of O(depth).

The cursor is base64url-encoded `{posted_at, id}` — opaque to clients (they must not construct or parse it, so we can change the encoding), tie-broken by `id` because timestamps collide. Invalid cursors are a 400, not a crash. `limit` clamps to 1–100.

## 8. Development methodology

**TDD, red → green → refactor**, for every non-trivial unit:

- **Unit**: cursor encode/decode (round-trip + tampered input), Meta client (pagination, retry/backoff, 4xx vs 5xx handling — mocked fetch), sync service orchestration (mocked ports), config validation.
- **Integration** (real Postgres via docker compose): migrations apply cleanly; upsert-twice yields one row with refreshed counts; keyset query ordering and boundaries.
- **API**: supertest — happy path, bad cursor, limit clamping.
- **Smoke**: `npm run sync:once` runs a real end-to-end sync against Meta.

Tests target the logic, not a coverage percentage. Trivial glue gets no tests (a test that restates the code is maintenance debt, not safety).

**Standards**: TS strict, no `any` in src, ESLint + Prettier, conventional commits, dependencies injected by constructor/params (no DI framework), `.env.example` documents every variable, secrets never committed.

## 9. Scalability path

What changes as this grows, in order — none of it built now, all of it accommodated by the current shape:

1. **More hashtags** — schema already supports it (`hashtags` table + FK); needs only an admin endpoint and per-hashtag cron entries. Mind the 30-queries/7-days hashtag-search limit.
2. **DLQ** — configure SQS redrive policy (maxReceiveCount → dead-letter queue) so poison jobs stop cycling. Config change, not code.
3. **Scheduled sync → EventBridge** — replace node-cron's `enqueue()` call with an EventBridge rule targeting the queue. One file.
4. **Worker → Lambda** — the SQS consumer's handler is already a pure `(job) => Promise<void>`; wrapping it in a Lambda handler is mechanical. Concurrency then scales automatically with queue depth.
5. **Read scale** — API is stateless (horizontal replicas); media assets served via CloudFront in front of S3; read replicas for Postgres long before the feed query is a problem (it's a single index seek).
6. **Metric freshness** — if like/comment counts need to be fresher than the 3h sync, add a lightweight refresh job for recent rows rather than shortening the whole sync interval.

## 10. Tradeoffs and shortcuts (honest ledger)

| Shortcut | Why acceptable here | Production fix |
|---|---|---|
| In-process node-cron | Repo runs with `npm start`; scheduler is one `enqueue()` call | EventBridge rule |
| No DLQ | Low job volume; failures visible in logs | SQS redrive policy |
| No metrics/tracing | Assignment scope | CloudWatch/OTel on job duration, queue depth, API latency |
| Single hashtag seeded | Assignment tracks `matcha` only | Admin CRUD + per-hashtag scheduling |
| Carousel children flattened | Read API doesn't need them | `media_children` table |
| Token in env, no refresh | Assignment provides a static token | Token refresh flow + secrets manager |
| 500-item cap drops older media on huge syncs | Explicit assignment bound | Cursor checkpointing across syncs |
