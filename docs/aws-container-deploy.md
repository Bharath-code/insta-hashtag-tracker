# Containerize and deploy to AWS

How to package this app as containers and run it on AWS. **Guide only — no application code changes required** beyond Docker/infra artifacts you would add when implementing.

The app already has production-shaped seams:

| Concern | Local | AWS |
|---|---|---|
| API process | `npm run dev:api` → `src/api.ts` | Container service A |
| Worker process | `npm run dev:worker` → `src/worker.ts` | Container service B |
| Queue | `QUEUE_DRIVER=local` | `QUEUE_DRIVER=sqs` + `SQS_QUEUE_URL` |
| Storage | `STORAGE_DRIVER=local` | `STORAGE_DRIVER=s3` + `S3_BUCKET` + `AWS_REGION` |
| Postgres | Docker Compose | RDS (or Aurora) |
| Secrets | `.env` | Secrets Manager / SSM Parameter Store |

Keep **two processes**: API (read-only, scale on HTTP load) and Worker (Meta + SQS + S3, scale on queue depth). Do not combine them into one container in production.

---

## 1. Target architecture (recommended)

```
                    Internet
                        │
                        ▼
                 ┌──────────────┐
                 │ Application  │  (ALB, optional HTTPS via ACM)
                 │ Load Balancer│
                 └──────┬───────┘
                        │ :3000
                        ▼
                 ┌──────────────┐
                 │  API tasks   │  ECS Fargate (desired count ≥ 2)
                 │  src/api.ts  │  QUEUE/STORAGE drivers unused for reads
                 └──────┬───────┘
                        │ DATABASE_URL
                        ▼
                 ┌──────────────┐
                 │ RDS Postgres │  private subnets
                 └──────▲───────┘
                        │
                 ┌──────┴───────┐
                 │ Worker tasks │  ECS Fargate (start with 1)
                 │ src/worker.ts│  cron + SQS consumer
                 └──────┬───────┘
           ┌────────────┼────────────┐
           ▼            ▼            ▼
      ┌────────┐  ┌──────────┐  ┌─────────┐
      │  SQS   │  │    S3    │  │  Meta   │
      │ queue  │  │  assets  │  │ Graph   │
      └────────┘  └──────────┘  └─────────┘
```

**Why this shape**

- Matches the existing split (`api.ts` / `worker.ts`).
- SQS and S3 drivers already exist in the repo.
- Fargate avoids managing EC2 capacity for a small workload.
- RDS is managed Postgres with backups and Multi-AZ options.
- ALB gives health checks and a stable public URL for `GET /hashtags`.

**Alternatives (when to pick them)**

| Option | Use when |
|---|---|
| **ECS on EC2** | You need cheaper steady-state compute and can manage capacity. |
| **EKS** | You already run Kubernetes; overkill for this app alone. |
| **App Runner** | API only; awkward for a long-running worker + cron. |
| **Elastic Beanstalk** | Prefer PaaS with less networking control; still need separate worker process. |
| **EC2 + Docker Compose** | Fastest DIY demo; no HA, you own patching and restarts. |
| **Lambda + EventBridge** | Production “ideal” for the sync path later (see `docs/ENGINEERING.md`); not required for first deploy. |

This document focuses on **ECS Fargate + RDS + SQS + S3**.

---

## 2. What to containerize

### 2.1 Images

Build **one image**, two commands:

| Role | Container command (conceptually) | Port |
|---|---|---|
| API | `node dist/api.js` (or `tsx`/`node` entry for `src/api.ts` after build) | `3000` |
| Worker | `node dist/worker.js` | none (no inbound traffic) |

Same image, different ECS task definitions / container overrides. That keeps CI simple and guarantees API and worker ship the same commit.

### 2.2 Dockerfile principles (what to put in it)

When you add a Dockerfile later, aim for:

1. **Base:** official Node 20+ slim (or Alpine if you accept musl tradeoffs).
2. **Multi-stage build:**
   - Stage 1: `npm ci`, compile TypeScript (`tsc`) if you ship JS, or install deps for production.
   - Stage 2: production `node_modules` only + built artifacts, non-root user.
3. **Do not bake secrets** into the image (no `.env`, no tokens).
4. **Do not bake local storage** assumptions for prod — worker will use S3.
5. **HEALTHCHECK** for the API image (optional in Docker; **required** as ALB target group health check hitting a cheap route — today that is effectively `GET /hashtags?limit=1` or a future `/health` if you add one).
6. **Migrations:** not automatically on every container start in multi-replica setups (race risk). Prefer:
   - one-off ECS task / CI job: `npm run db:migrate`, or
   - a dedicated migrate step in the deploy pipeline before traffic switch.

### 2.3 Local multi-service compose (optional parity)

Extend the idea of today’s `docker compose` (Postgres only) to a full stack for smoke tests:

| Service | Image / build | Notes |
|---|---|---|
| `postgres` | `postgres:16-alpine` | Already present |
| `api` | app image, command = API | `DATABASE_URL` points at `postgres` service |
| `worker` | app image, command = worker | Same network; can stay on local queue/storage for laptop demos |

For **AWS-like local testing**, point worker/API at real SQS/S3 with AWS credentials in env, or use LocalStack only if you accept extra complexity (not required by this repo).

---

## 3. AWS building blocks

Create these before (or with) first deploy. Prefer **one VPC**, private app + data subnets, public subnets only for ALB and NAT.

### 3.1 Networking

| Resource | Purpose |
|---|---|
| VPC | Isolation boundary |
| Public subnets (2 AZs) | ALB, NAT Gateway(s) |
| Private subnets (2 AZs) | ECS tasks, RDS |
| Security groups | See below |
| NAT Gateway | Outbound from private tasks (Meta API, S3, SQS, ECR pull if needed) |

**Security groups (minimal)**

| SG | Inbound | Outbound |
|---|---|---|
| ALB | 443 (and/or 80) from internet | to API SG on 3000 |
| API tasks | 3000 from ALB SG only | to RDS 5432, HTTPS out if needed |
| Worker tasks | none | to RDS 5432, SQS, S3, Meta (`graph.facebook.com`) over HTTPS |
| RDS | 5432 from API SG + Worker SG only | minimal |

### 3.2 Data plane

| Resource | Settings to consider |
|---|---|
| **RDS PostgreSQL 16** | `hashtag` DB; Multi-AZ for prod; storage autoscaling; private only; automated backups |
| **S3 bucket** | Private; block public access; optional lifecycle rules; server-side encryption (SSE-S3 or SSE-KMS) |
| **SQS standard queue** | Visibility timeout ≥ longest sync duration (asset uploads can take minutes; start with 5–15 min); redrive to **DLQ** after N receives |
| **SQS DLQ** | Capture poison messages; alarm on `ApproximateNumberOfMessagesVisible` |

Optional later:

- CloudFront in front of S3 if you ever serve assets publicly (API currently returns `storage_key` / Meta URLs; serving from CDN is a product choice).
- RDS Proxy if connection churn becomes an issue under many tasks.

### 3.3 Container registry and compute

| Resource | Purpose |
|---|---|
| **ECR repository** | Store `hashtag-tracker` images (tag by git SHA + `latest` for non-prod) |
| **ECS cluster** | Fargate capacity provider |
| **Task definition — API** | CPU/memory (e.g. 0.25–0.5 vCPU, 512–1024 MB to start), port 3000, env + secrets |
| **Task definition — Worker** | Similar or slightly more memory (downloads), no load balancer |
| **ECS Service — API** | Desired count ≥ 2, ALB target group, rolling deploy |
| **ECS Service — Worker** | Desired count 1 initially (cron lives in-process; multiple workers are OK for SQS consumers but **duplicate crons** will double-enqueue — see §6) |
| **ALB + target group** | HTTP/HTTPS, health check path/interval |
| **ACM certificate** | HTTPS on ALB |
| **Route 53** (optional) | DNS name for the API |

### 3.4 Secrets and config

**Never** put `META_ACCESS_TOKEN` in plain ECS env if you can avoid it. Use:

- **AWS Secrets Manager** or **SSM Parameter Store (SecureString)** for:
  - `META_ACCESS_TOKEN`
  - RDS password / full `DATABASE_URL`
- Inject into task definition as `secrets:` (ECS native), not baked into the image.

**Plain env (non-secret) examples**

| Variable | Production value |
|---|---|
| `QUEUE_DRIVER` | `sqs` |
| `STORAGE_DRIVER` | `s3` |
| `SQS_QUEUE_URL` | full queue URL |
| `S3_BUCKET` | bucket name |
| `AWS_REGION` | e.g. `ap-south-1` / `us-east-1` |
| `META_USER_ID` | Instagram business account id |
| `META_API_BASE` | `https://graph.facebook.com/v24.0` (or pin a version) |
| `PORT` | `3000` |
| `SYNC_MAX_ITEMS` | `500` (tune cost/time) |
| `META_PAGE_SIZE` | **start low (e.g. 5–10)** — Meta hashtag media can reject larger pages with “reduce the amount of data” |
| `DATABASE_URL` | via secret |

IAM on the **task role** (not the user):

- `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes`, `SendMessage` on the queue ARN  
- `s3:PutObject`, `GetObject` (and `ListBucket` if needed) on the bucket ARN  
- Secrets Manager / SSM `GetSecretValue` for the secrets ARNs  

Use the **task execution role** for ECR pull + writing logs to CloudWatch.

---

## 4. Containerization steps (checklist)

1. Add a production Dockerfile (multi-stage, non-root).
2. Decide start command: compile with `tsc` and run `node`, or use a small production runner — prefer compiled JS in prod.
3. Ensure `package.json` has a build script if not already (`tsc` / compile).
4. `.dockerignore`: `node_modules`, `.env`, `storage/`, `tests/`, docs noise, git history.
5. Local build and run:
   - Build image.
   - Run Postgres (Compose).
   - Run API container with `DATABASE_URL` to host/network Postgres.
   - Run worker container with Meta token + local or AWS drivers.
6. Tag and push to ECR:
   - Auth Docker to ECR.
   - Push `account.dkr.ecr.region.amazonaws.com/hashtag-tracker:<git-sha>`.
7. Smoke-test image by running one-off:
   - migrate task
   - optional `sync:once` equivalent (worker job or one-shot container command)

---

## 5. Deploy steps on AWS (order of operations)

### Phase A — Foundation

1. Create VPC (or use existing) with public/private subnets across 2 AZs.
2. Create security groups (ALB, API, Worker, RDS).
3. Create RDS Postgres; store credentials in Secrets Manager.
4. Create S3 bucket (block public access).
5. Create SQS queue + DLQ + redrive policy; set visibility timeout thoughtfully.
6. Create ECR repo; push first image.

### Phase B — Runtime

7. Create ECS cluster (Fargate).
8. Create CloudWatch log groups: `/ecs/hashtag-api`, `/ecs/hashtag-worker`.
9. Create task roles/execution roles with least privilege.
10. Register **API** task definition (image SHA, secrets, env, port mapping 3000).
11. Register **Worker** task definition (same image, worker command, same secrets/env for Meta/SQS/S3/DB).
12. Create ALB, target group (health check), listener (443 + cert).
13. Create **API service** attached to ALB (private subnets, public IP off if using NAT).
14. Run **one-off migrate** task against RDS (`npm run db:migrate` / compiled equivalent) — seeds `matcha`.
15. Create **Worker service** (desired count 1 to start).
16. Confirm worker logs: hashtag resolved, jobs consumed, assets landing in S3, rows in RDS.
17. Hit ALB: `GET /hashtags?limit=10` → 200 with data; invalid cursor → 400.

### Phase C — Hardening

18. CloudWatch alarms: ALB 5xx, target unhealthy, SQS DLQ depth, RDS CPU/storage, ECS CPU/memory.
19. Enable container Insights or basic metrics.
20. Restrict security groups; confirm RDS not public.
21. Rotate Meta token procedure documented; store only in Secrets Manager.
22. Backup: RDS snapshots + (optional) S3 versioning.
23. Cost controls: Fargate right-sizing, single NAT in non-prod, S3 lifecycle for old media if appropriate.

---

## 6. Process-specific notes for *this* app

### API

- Stateless: safe to run N replicas behind ALB.
- Only needs `DATABASE_URL` (and `PORT`). It does not call Meta, SQS, or S3 for `GET /hashtags`.
- You can still inject full env for one shared task definition family if simpler; unused drivers are fine.

### Worker

- Calls Meta, writes Postgres, puts objects to S3, consumes/enqueues SQS.
- On boot it may enqueue sync jobs and runs **node-cron every 3 hours**.
- **Scaling workers:**
  - Multiple workers are fine for **SQS consumption** (competing consumers).
  - Multiple workers each run **cron**, so you may get duplicate enqueues. That is usually OK because ingestion is **idempotent** (`ON CONFLICT` upsert + skip uploaded assets), but it wastes Meta quota and cost. Prefer:
    - **1 worker task** for first production, or
    - later: EventBridge rule → enqueue only (cron removed from process), N workers pure consumers.

### Migrations

- Run as a **pipeline step** or **one-shot ECS task** with the new image before/while deploying services.
- Do not race `db:migrate` from every API replica on start.

### Meta token and quotas

- Token must remain valid (long-lived page/system user token as appropriate for your Meta app).
- Hashtag search is rate-limited (unique searches per 7 days); production relies on **cached** `hashtags.meta_hashtag_id` after first resolve.
- Use a conservative `META_PAGE_SIZE` if Graph returns “Please reduce the amount of data you're asking for”.

### SQS semantics

- At-least-once delivery is assumed; code path is idempotent.
- Visibility timeout must exceed a full sync (fetch pages + asset uploads). If a job times out mid-sync, redelivery re-upserts and resumes pending `storage_key IS NULL` uploads.
- Configure DLQ; monitor it.

### S3

- Keys look like `media/<meta_media_id>.jpg|mp4` (see sync service).
- Bucket stays private; API currently exposes `storage_key` and Meta `media_url` in JSON — if clients should load durable copies, add signed URLs or CloudFront later (out of scope for first deploy).

---

## 7. CI/CD sketch

Suggested pipeline (GitHub Actions, CodePipeline, etc.):

1. **Test** — `npm test` (needs Postgres service container), `npm run typecheck`, `npm run lint`.
2. **Build** — Docker build, tag with git SHA.
3. **Push** — ECR.
4. **Migrate** — run one-off task/job with new image against target env RDS.
5. **Deploy** — update ECS API service then Worker service to new task definition (rolling).
6. **Smoke** — curl ALB `/hashtags?limit=1`; assert 200.

Environments: `dev` / `staging` / `prod` with separate RDS, queues, buckets, and secrets.

---

## 8. Environment matrix

| Variable | Local compose | AWS ECS |
|---|---|---|
| `DATABASE_URL` | `postgres://…@localhost:5432/hashtag` | RDS endpoint + secret password |
| `QUEUE_DRIVER` | `local` | `sqs` |
| `STORAGE_DRIVER` | `local` | `s3` |
| `SQS_QUEUE_URL` | empty | queue URL |
| `S3_BUCKET` / `AWS_REGION` | empty / optional | set |
| AWS credentials | none (local drivers) | **task IAM role** (preferred over access keys) |
| `META_*` | `.env` | Secrets Manager → task secrets |
| `STORAGE_LOCAL_DIR` | `./storage` | unused when `s3` |

---

## 9. Minimal “weekend” deploy (if you skip HA)

If the goal is a demo, not multi-AZ production:

1. One EC2 (or single-AZ Fargate).
2. Docker Compose on the box: `api`, `worker`, `postgres` **or** RDS free-tier + two containers.
3. Still use **S3 + SQS** with `QUEUE_DRIVER=sqs` / `STORAGE_DRIVER=s3` so you exercise real AWS drivers.
4. Security group: only 3000 (or 443) open; Postgres never public.
5. Accept single points of failure; document as non-prod.

This is fine for assignment demos; use §1–§5 for anything long-lived.

---

## 10. Verification after deploy

| Check | Expected |
|---|---|
| RDS `hashtags` | Row `matcha` with `meta_hashtag_id` set after first worker run |
| RDS `media` | Rows growing after sync; `storage_key` populated for successful uploads |
| S3 | Objects under `media/…` |
| SQS | In-flight messages during sync; DLQ empty under healthy runs |
| `GET https://<alb>/hashtags?limit=10` | 200, newest-first JSON, `nextCursor` when more pages |
| `GET …&cursor=bad` | 400 `invalid cursor` |
| CloudWatch logs | API access/errors; worker sync progress and isolated asset failures (one bad asset must not kill the batch) |
| Second sync | No duplicate PK errors; counts/like fields refresh; already-stored assets skipped |

---

## 11. Operational runbook (short)

| Event | Action |
|---|---|
| Meta token expired | Update secret; restart worker tasks (API can stay) |
| Queue backing up | Increase worker desired count (watch duplicate cron) or raise task CPU/memory |
| Asset upload failures | Check S3 permissions, Meta CDN URL expiry (re-sync refreshes `media_url`) |
| API latency | Scale API service; check RDS connections/CPU |
| Deploy failed health checks | Confirm security groups, `PORT`, and that migrations applied |
| Poison job | Message lands in DLQ; inspect body; fix data/bug; redrive or discard |

---

## 12. What not to do

- Do not run API and worker as one process in prod (coupling, scaling, failure domains).
- Do not use `QUEUE_DRIVER=local` on multi-task ECS (in-memory queue is per process and not shared).
- Do not use `STORAGE_DRIVER=local` on Fargate without a shared volume strategy — tasks are ephemeral; **use S3**.
- Do not put RDS in a public subnet “for convenience.”
- Do not commit `.env` or bake `META_ACCESS_TOKEN` into images.
- Do not set `META_PAGE_SIZE` high without verifying Meta accepts it for hashtag media in your app/region.

---

## 13. Related docs

| Doc | Content |
|---|---|
| [`README.md`](../README.md) | Local quick start |
| [`instructions.md`](../instructions.md) | Env vars, tradeoffs |
| [`docs/ENGINEERING.md`](ENGINEERING.md) | Design rationale, scale-up path (EventBridge/Lambda, CloudFront) |
| [`docs/db-access.md`](db-access.md) | How to inspect Postgres locally |
| Spec / plan under `docs/superpowers/` | Original assignment design |

---

## 14. Suggested implementation order (when you build this)

1. Dockerfile + local API/worker containers against Compose Postgres.  
2. ECR + push.  
3. RDS + Secrets.  
4. S3 + SQS + IAM roles.  
5. ECS API + ALB.  
6. Migrate + worker service.  
7. End-to-end sync + `GET /hashtags`.  
8. Alarms, HTTPS, multi-AZ, CI/CD.

No application feature work is required for a first AWS deploy beyond packaging, config, and infra — the SQS and S3 drivers are already in the codebase.
