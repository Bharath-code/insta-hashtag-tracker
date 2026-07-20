# Deploy this app fully on AWS (hireable portfolio path)

Goal: run **Instagram hashtag tracker entirely on AWS** (no laptop required for runtime), with an architecture you can defend in interviews as **backend + AWS + data pipeline + API** experience.

This is a **design and delivery guide**, not code. Related: [`aws-container-deploy.md`](aws-container-deploy.md), [`ENGINEERING.md`](ENGINEERING.md).

---

## 1. What you are shipping (one sentence)

A **production-shaped ingestion system**: Meta Graph API → async jobs (SQS) → worker → Postgres (RDS) + durable media (S3) → public read API (`GET /hashtags`) with cursor pagination.

That maps cleanly to roles like **Backend Engineer**, **Full-stack (Node)**, **Cloud / Platform**, **Data pipeline**.

---

## 2. Pick one architecture (recommendation first)

### Recommended for hireability: **ECS Fargate (Docker) + managed AWS services**

| Layer | Service | Why it impresses |
|---|---|---|
| Containers | **ECS Fargate** (API + Worker tasks) | Real container orchestration without EC2 babysitting |
| Load balancer | **ALB** + **ACM** HTTPS | Public API, health checks, multi-AZ |
| Database | **RDS PostgreSQL** (private) | Managed relational DB, backups, security groups |
| Queue | **SQS** (+ DLQ) | Decoupled async work, at-least-once, retries |
| Files | **S3** | Durable assets (Meta CDN URLs expire) |
| Secrets | **Secrets Manager** | Tokens/DB password not in code |
| Logs/metrics | **CloudWatch** | Ops story |
| Optional CDN | **CloudFront** in front of S3 or ALB | “Assets / edge” talking point |
| Optional IaC | **AWS CDK or Terraform** | “I didn’t click-ops production” |

**Why not pure “serverless-only” as the first deploy?**

This repo is already **two long-running Node processes** (`api.ts`, `worker.ts`) with:

- Express HTTP server  
- In-process SQS poller + **node-cron**  
- Multi-minute sync (Meta pages + asset downloads)

That fits **Fargate perfectly** today. Pure Lambda needs code changes (HTTP adapter, SQS event handler, EventBridge instead of cron, cold starts, 15 min timeout for big syncs).

### Strong alternative: **Serverless-leaning (phase 2)**

| Piece | Service |
|---|---|
| API | API Gateway HTTP API → **Lambda** (or Lambda Web Adapter) |
| Sync jobs | **SQS** → **Lambda** worker |
| Schedule | **EventBridge** rule every 3h → enqueue / invoke |
| DB | **RDS** (or Aurora Serverless v2) |
| Media | **S3** |

Best as a **second blog post / PR**: “Migrated worker to Lambda + EventBridge.” Shows evolution, not just first deploy.

### Avoid for portfolio (unless demo only)

| Approach | Problem |
|---|---|
| One EC2 + `docker compose` forever | Looks like a hobby VPS, weak AWS story |
| Everything “local Docker” only | No cloud evidence |
| Root account + access keys in GitHub | Instant reject / security red flag |

---

## 3. Target architecture (no local runtime)

```
                         Internet users / recruiters
                                   │
                                   ▼
                          ┌────────────────┐
                          │ Route 53 (opt) │
                          │ ACM cert       │
                          └───────┬────────┘
                                  │ HTTPS
                                  ▼
                          ┌────────────────┐
                          │      ALB       │  public subnets
                          └───────┬────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
           ┌────────────────┐          ┌────────────────┐
           │ ECS Fargate    │          │ ECS Fargate    │
           │ SERVICE: api   │          │ SERVICE: worker│
           │ cmd: node api  │          │ cmd: node worker│
           │ scale on CPU   │          │ scale on SQS   │
           └───────┬────────┘          └───────┬────────┘
                   │ private subnets            │
                   │                            │
         DATABASE_URL                  SQS + S3 + Meta HTTPS
                   │                            │
                   ▼                            ▼
           ┌────────────────┐          ┌───────┴───────┐
           │ RDS Postgres   │          │ SQS  │  S3    │
           │ (private)      │          │ +DLQ │ media/ │
           └────────────────┘          └───────────────┘
                   ▲
                   │ Secrets Manager
           META_ACCESS_TOKEN, DB password
```

**Runtime env (production)**

```text
QUEUE_DRIVER=sqs
STORAGE_DRIVER=s3
SQS_QUEUE_URL=...
S3_BUCKET=...
AWS_REGION=ap-south-2   # or your region
DATABASE_URL=...        # from Secrets Manager
META_ACCESS_TOKEN=...   # from Secrets Manager
META_USER_ID=...
META_PAGE_SIZE=3        # Meta hashtag media is picky about page size
SYNC_MAX_ITEMS=500
PORT=3000
```

No `localhost`, no `./storage`, no laptop Docker for production traffic.

---

## 4. How this maps to “full-stack + AWS” on a resume

You are not “just hosting Express.” Interview narrative:

1. **Ingestion pipeline** — external API (Meta), rate limits, retries, idempotent upserts  
2. **Async systems** — SQS at-least-once, DLQ, worker separation from API  
3. **Data model** — keyset pagination, PK = Meta media id, nullable `storage_key` for resumable uploads  
4. **Cloud native storage** — S3 because CDN URLs expire  
5. **Containers on AWS** — multi-service ECS, IAM task roles, private networking  
6. **Security** — secrets, least-privilege IAM, private RDS, no public DB  
7. **Ops** — health checks, logs, alarms, rolling deploys  

### Resume bullets (adapt)

- Designed and deployed a **Node.js/TypeScript Instagram hashtag ingestion pipeline** on **AWS (ECS Fargate, RDS Postgres, SQS, S3)** with a cursor-paginated public API.  
- Separated **read API and async workers**; used **SQS** for job decoupling and **S3** for durable media copies of expiring CDN URLs.  
- Implemented **idempotent upserts** and resumable asset uploads so at-least-once queue delivery stays correct.  
- Provisioned infra with **CDK/Terraform**, secrets in **Secrets Manager**, observability via **CloudWatch**.  

### Portfolio README section (what recruiters open)

1. Architecture diagram (copy §3)  
2. Live URL: `https://api.yourdomain.com/hashtags?limit=5`  
3. One-click or scripted deploy notes  
4. Cost estimate (~$ / month)  
5. Tradeoffs (cron in worker vs EventBridge; Fargate vs Lambda)  
6. Screenshots: ECS services, S3 objects, RDS, CloudWatch, API JSON  

---

## 5. Build order (ship something live in days, not months)

### Phase 0 — already done in this project

- [x] API + worker split  
- [x] SQS + S3 drivers  
- [x] Postgres schema, migrations, tests  
- [x] S3 bucket + SQS queue + IAM user (local)  

### Phase 1 — container image (required for Fargate)

1. Multi-stage **Dockerfile** (Node 20, non-root, production deps).  
2. One image, two commands: `node dist/api.js` and `node dist/worker.js`.  
3. Push to **ECR** tagged with git SHA.  
4. `.dockerignore` (no `.env`, no local `storage/`).  

### Phase 2 — data plane (always on AWS)

1. **VPC**: public + private subnets, 2 AZs, NAT for private egress (Meta, S3, SQS).  
2. **RDS Postgres 16**: private, security group only from ECS tasks, automated backups.  
3. **S3** bucket (you have one): block public access, encryption.  
4. **SQS** + **DLQ** redrive (you have a queue): set visibility timeout ≥ worst-case sync.  
5. **Secrets Manager**: `DATABASE_URL`, `META_ACCESS_TOKEN`.  

### Phase 3 — compute

1. **ECS cluster** (Fargate).  
2. Task roles (not access keys on the task):  
   - API: RDS only (via network + secret).  
   - Worker: SQS + S3 + secret + outbound HTTPS to Meta.  
3. **API service** behind **ALB** (desired count 2 for story; 1 OK for cheap demo).  
4. One-off **migrate task** (`db:migrate`) before traffic.  
5. **Worker service** desired count 1 (cron lives in process; multi-worker duplicates schedules — OK idempotently but wasteful).  

### Phase 4 — public demo polish

1. ACM certificate + HTTPS listener.  
2. Optional Route 53 name.  
3. CloudWatch alarms: ALB 5xx, unhealthy targets, DLQ depth, RDS CPU.  
4. GitHub Actions: test → build → push ECR → update ECS.  
5. Optional: CloudFront for media if you add signed URLs later.  

### Phase 5 — “serverless evolution” (optional, hire boost)

1. EventBridge every 3h → `SendMessage` to SQS (remove dependency on node-cron).  
2. Lambda SQS consumer wrapping existing `SyncService.run`.  
3. API Gateway + Lambda for `GET /hashtags` (or keep Fargate API only).  

Document both: **v1 Fargate**, **v2 serverless worker**.

---

## 6. Docker on AWS vs “AWS Serverless” — decision table

| Criterion | ECS Fargate (Docker) | Serverless (Lambda + API GW + EventBridge) |
|---|---|---|
| Fits current code | **Yes, almost as-is** | Needs adapters |
| Interview story | Containers, networking, multi-service | Event-driven, scale-to-zero |
| Long sync (many assets) | Easy (long-running task) | Watch 15 min Lambda limit; chunk jobs |
| Cron | node-cron in worker or EventBridge | EventBridge natural |
| Cost at low traffic | Always-on tasks (~tens of USD/mo with NAT+RDS) | Can be cheaper if idle; RDS still costs |
| Hire signal for backend | Very strong | Very strong if you show the migration |

**Hireable default:** ship **Fargate v1**, mention serverless as next step with a short design note in README.

---

## 7. Networking and security (what interviewers ask)

| Question | Your answer |
|---|---|
| Is the database public? | **No.** Private subnets; SG allows 5432 only from ECS task SGs. |
| How do tasks get AWS access? | **Task IAM role** (no long-lived keys in env). |
| Where is the Meta token? | **Secrets Manager**, injected into the task. |
| Why S3? | Meta `media_url` expires; we store durable copies; `storage_key` set after upload. |
| Why SQS not call Meta from the API? | Isolate latency/failures; API stays read-only and fast. |
| How do you avoid duplicate media? | Meta media id = PK; `ON CONFLICT DO UPDATE`. |
| How do you paginate? | Keyset on `(posted_at, id)`, opaque cursor. |

---

## 8. Cost ballpark (India / ap-south-2 — order of magnitude)

For a **portfolio demo** (not production scale):

| Item | Cheap demo | “Looks real” |
|---|---|---|
| RDS db.t4g.micro | ~$12–20/mo | Multi-AZ costs more |
| Fargate API 0.25 vCPU × 1 | ~$5–15/mo | ×2 tasks |
| Fargate worker × 1 | ~$5–15/mo | |
| NAT Gateway | **often largest** (~$30+/mo) | Dev: single NAT; or VPC endpoints for S3/SQS to cut traffic |
| ALB | ~$16+/mo | |
| S3 + SQS | cents–few dollars | |
| **Rough total** | **~$50–100/mo** | Higher with Multi-AZ + 2 NATs |

**Cost control for portfolio:**

- Stop/scale ECS services to 0 when not demoing (RDS still bills).  
- Use **single-AZ RDS** for demo.  
- Prefer **VPC endpoints** for S3/SQS to reduce NAT data.  
- Tear down non-prod with CDK `destroy` when idle.  
- Tag everything `Project=hashtag-tracker`, `Env=portfolio`.

---

## 9. CI/CD that looks professional

```text
GitHub main push
  → npm test + typecheck + lint
  → docker build → ECR (tag: git sha)
  → ECS migrate one-off task
  → Update API service
  → Update worker service
  → Smoke: curl https://api.../hashtags?limit=1
```

Secrets in GitHub Actions: OIDC to AWS (no static keys in repo) — strong interview point.

---

## 10. Demo script for interviews (5 minutes)

1. Open architecture diagram.  
2. Hit live `GET /hashtags?limit=3` — show cursor + `storage_key`.  
3. AWS Console: ECS services healthy, SQS empty/DLQ zero, S3 `media/` objects.  
4. Show RDS query or CloudWatch log line from a sync.  
5. Walk code: `SyncService` upsert + upload; `GET /hashtags` keyset.  
6. “If I had another week: EventBridge schedule + Lambda worker + CloudFront signed URLs.”

---

## 11. What to implement vs what you already have

| Component | Status in repo | Deploy work |
|---|---|---|
| Express API | Done | Dockerfile + ECS + ALB |
| Worker + cron | Done | ECS worker service |
| SQS driver | Done | Real queue URL + IAM |
| S3 driver | Done | Bucket + IAM |
| Postgres | Done | RDS + migrate task |
| Secrets | `.env` local | Secrets Manager |
| IaC | Not in repo | CDK/Terraform (add) |
| CI | Not required | GitHub Actions (add) |
| Domain/HTTPS | No | ACM + Route 53 |

You do **not** need a rewrite to be hireable. You need a **clean cloud deploy + story + diagram + live URL**.

---

## 12. Suggested project title and pitch

**Title:** AWS-hosted Instagram Hashtag Ingestion Pipeline  

**Pitch (30 seconds):**  
“I built a TypeScript service that syncs Instagram hashtag media from Meta’s Graph API into Postgres and S3 using SQS-backed workers, and exposes a cursor-paginated read API. It’s deployed on ECS Fargate with RDS, secrets in Secrets Manager, and fully managed AWS networking—no local dependencies for production.”

**Keywords:** Node.js, TypeScript, Express, PostgreSQL, SQS, S3, ECS Fargate, RDS, Docker, IAM, Secrets Manager, keyset pagination, idempotent pipelines.

---

## 13. Practical next actions (in order)

1. **Dockerfile + ECR push** for this repo.  
2. **RDS** in private subnets + run migrations.  
3. Point env to existing **SQS + S3** (`QUEUE_DRIVER=sqs`, `STORAGE_DRIVER=s3`).  
4. **ECS services** (api + worker) + **ALB**.  
5. Secrets Manager for Meta token + DB URL.  
6. HTTPS + public demo URL.  
7. README: architecture, live curl, cost, tradeoffs.  
8. (Optional) CDK stack so destroy/recreate is one command.  
9. (Optional) EventBridge + Lambda worker as “v2”.  

---

## 14. Related docs

| Doc | Use |
|---|---|
| [`aws-container-deploy.md`](aws-container-deploy.md) | Detailed ECS/Fargate checklist |
| [`db-access.md`](db-access.md) | Local DB inspection (dev only) |
| [`ENGINEERING.md`](ENGINEERING.md) | Design decisions to discuss in interviews |
| [`instructions.md`](../instructions.md) | Env vars |

---

## Bottom line

| Question | Answer |
|---|---|
| Deploy with Docker on AWS? | **Yes — ECS Fargate** (best fit, strongest immediate hire story). |
| Pure serverless? | **Possible later** (Lambda + API GW + EventBridge); not the first port. |
| Need local machine for prod? | **No** — RDS + ECS + SQS + S3 + Secrets. |
| Hireable? | **Yes**, if live URL + diagram + IAM/security story + honest tradeoffs. |

**Ship Fargate + RDS + SQS + S3 first.** Call serverless a deliberate phase-2 evolution. That combination reads as senior-junior / mid-level backend cloud competence, not a toy tutorial.
