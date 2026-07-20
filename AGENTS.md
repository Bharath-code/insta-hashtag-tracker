# AGENTS.md

Instructions for coding agents working in **insta-hashtag-track**.  
Deeper product rationale: [`docs/ENGINEERING.md`](docs/ENGINEERING.md). Parallel agent guide: [`CLAUDE.md`](CLAUDE.md). Human setup: [`README.md`](README.md), [`instructions.md`](instructions.md).

## Project in one paragraph

Idempotent Instagram hashtag ingestion: **Worker** pulls Meta top/recent media → upserts Postgres → copies assets to storage (Meta CDN URLs expire). **API** is a separate process that only reads Postgres and serves cursor-paginated `GET /hashtags`. Local drivers by default; production can use SQS + S3 and runs on **ECS Fargate** (`deploy/`, region `ap-south-2`).

## Hard constraints

1. **Two entry points only for runtime:** `src/api.ts` (read) and `src/worker.ts` (ingest). Do not put Meta/S3 calls in the API.
2. **Only two swappable abstractions:** `Queue` (`QUEUE_DRIVER=local|sqs`) and `Storage` (`STORAGE_DRIVER=local|s3`). No new repository/DI frameworks.
3. **Dedupe in the DB** — Meta media ID is PK; use upsert, not read-before-write.
4. **Idempotent jobs** — design for SQS at-least-once and mid-job crash/retry.
5. **Secrets** — never commit `.env`, tokens, or `problem_statement.md` credentials.

## Where to start in code

| Goal | Start here |
|------|------------|
| HTTP / pagination | `src/app.ts`, `src/services/cursor.ts`, `src/services/media-repo.ts` |
| Ingestion | `src/worker.ts` → `src/services/sync.ts` → `src/meta/client.ts` |
| Drivers | `src/queue/`, `src/storage/index.ts` |
| Config / wiring | `src/config.ts`, `src/bootstrap.ts` |
| Schema | `src/db/migrations/` |
| Prod image / AWS ops | `Dockerfile`, `deploy/` |

## Commands (short)

```bash
docker compose up -d && npm run db:migrate
npm run dev:api          # :3000
npm run dev:worker
npm run sync:once
npm test                 # needs Postgres
npm run build && npm run start:api   # production-style
npm run aws:sql | aws:stop | aws:start   # live stack helpers
```

## Architecture reminders

- Sync: page fetch → per-page upsert → upload rows with `storage_key IS NULL` (resumable). Partial Meta failure still drains pending uploads, then fails the job.
- Meta: cache hashtag ID; retry 429/5xx only; fail fast on 4xx.
- Feed sort: `posted_at` + `id`, not ingest time.
- RDS: TLS in `src/db/index.ts` for `*.rds.amazonaws.com`; local Docker Postgres is plain.
- Cron is **in-process** (`node-cron`); it only **enqueues**. Worker process stays always-on in ECS.

## AWS guidance (this repo)

- Prefer AWS MCP when available; else AWS CLI. Confirm uncertain service details against docs.
- App already has SQS/S3 drivers; deploy artifacts are under `deploy/` (task JSON, scripts). Update those when changing how the live stack runs.
- Live region: **ap-south-2**. See `deploy/LIVE.md` for resource names (ALB, ECS services, RDS, S3, SQS, secret **names**).
- Prefer IaC for new long-lived infra when the user asks; do not invent a parallel stack without being asked.
- Resource names: hyphens only (no em dashes).
- ECS: task role for S3/SQS; Secrets Manager injects `DATABASE_URL` / Meta token — do not bake secrets into images.

### Secret safety

- Never print or commit secret **values**.
- Prefer runtime resolution (ECS secrets, or secrets-manager skill / `asm-exec` patterns) over pulling secrets into the agent transcript.
- Do not use raw `get-secret-value` / daemon reads when a resolve-at-runtime path exists.

## Docs map

| Doc | Use |
|-----|-----|
| `docs/ENGINEERING.md` | Why the design is this way |
| `local-notes/` (gitignored) | Local personal prep notes — do not commit |
| `deploy/README.md` / `LIVE.md` | Deploy + live URLs |
| `docs/aws-*.md` | Portfolio / console / container guides |
| `instructions.md` | Reviewer setup + env table |

## PR / change hygiene

- Keep diffs focused; match existing style (strict TS, Knex, zod).
- Tests: logic first (sync, cursor, meta retries, upsert); integration against real Postgres when touching DB.
- If setup steps change, update `instructions.md` and `README.md`.
