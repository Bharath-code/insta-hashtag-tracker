# Worker, 3-hour cron, and why S3 upload times cluster

How scheduling works in production, and how to read DB / S3 timestamps without confusion.

Related: [`aws-console-and-query.md`](aws-console-and-query.md), [`deploy/LIVE.md`](../deploy/LIVE.md), [`ENGINEERING.md`](ENGINEERING.md).

---

## 1. Short answer

| Question | Answer |
|---|---|
| Is there a 3-hour cron? | **Yes** — it only **enqueues** a sync job |
| Does the worker run only every 3 hours? | **No** — the worker is **always on** (ECS service) |
| Why do many S3 files share nearly the same time? | **One sync job** uploads **many** assets over a few minutes |
| Do close S3 times mean cron is broken? | **No** — that is normal batch upload behavior |

---

## 2. Two different clocks

### A. Worker process (always running)

- ECS service: `hashtag-tracker-worker` (desired count ≥ 1)
- Continuously **polls SQS**
- When a message arrives, runs `SyncService`:
  1. Fetch hashtag media from Meta  
  2. Upsert rows into Postgres  
  3. Download pending assets and `PutObject` to S3  
  4. Set `media.storage_key`

### B. Cron (only schedules work)

- Runs **inside** the worker process: `0 */3 * * *` (every 3 hours, at minute 0)
- Does **not** upload files by itself
- Only does: **enqueue** `SYNC_RECENT_HASHTAG_MEDIA` for `matcha` onto SQS

Also on **worker boot** (every new ECS task start / redeploy):

- Enqueues a **recent** sync immediately  
- May enqueue **top** sync if `last_synced_at` is null  

So redeploys cause **extra** syncs outside the 3-hour grid.

```text
Worker always running
    │
    ├─ every 3h: cron → SQS message "sync recent"
    ├─ on boot:   also enqueue sync (deploy/restart effect)
    └─ SQS consumer → one job:
           Meta fetch → DB upsert → many S3 uploads (minutes)
```

---

## 3. What “every 3 hours” is *not*

| Misconception | Reality |
|---|---|
| Worker process starts every 3 hours | Worker stays up 24/7 |
| Exactly one S3 object every 3 hours | One job can upload **hundreds** of objects |
| S3 LastModified spaced 3 hours apart | LastModified is **per-file finish time** during a batch |
| Quiet S3 means worker is down | Queue may simply be empty between jobs |

---

## 4. Why S3 timestamps look “all at once”

Example window observed in production (IST):

| Label (IST) | Approx UTC | Meaning |
|---|---|---|
| Jul 19, 23:59:59 | ~18:29 UTC | Mid upload burst |
| Jul 20, 00:06:19 | ~18:36 UTC | Late in same burst |

DB around that period showed:

- All rows’ `updated_at` clustered roughly **18:25–18:36 UTC**  
- That is **~23:55–00:06 IST** — same band as S3  

### Inside one job

Uploads use **concurrency** (several downloads/puts at once).  
So S3 **LastModified** values sit **seconds apart** across many keys. That looks like “constant uploading,” but it is still **one scheduled (or boot-triggered) job**.

### `posted_at` vs upload time

| Field | Meaning |
|---|---|
| `media.posted_at` | When Instagram created the post |
| `media.updated_at` | When **our** pipeline last wrote the row |
| S3 object LastModified | When **our** worker finished `PutObject` |

Close S3 times do **not** mean Instagram posted them all then.

---

## 5. Extra reasons for dense activity (especially deploy night)

These are **not** the 3-hour cron:

1. **ECS redeploy / new task** → boot enqueue → full sync  
2. **SQS retries** after failed jobs (Meta “reduce data”, etc.)  
   - Failed messages are **not** deleted  
   - They reappear after **visibility timeout** (minutes), so logs can show retries often  
3. **Backlog drain** after fixing S3 uploads: many rows had `storage_key IS NULL`, then one successful job uploaded a large pending set  
4. **Partial Meta pages** + continued pending asset uploads after fetch issues (post–S3-fix behavior)

Steady state (no deploys, healthy Meta): expect activity near the **3-hour marks**, plus quiet gaps—not continuous floods.

---

## 6. How DB and S3 should relate

```text
1. Upsert media row (Postgres)
2. If storage_key IS NULL and media_url present:
     download CDN → S3 put → set storage_key
```

| Observation | Interpretation |
|---|---|
| DB rows grow, `storage_key` null | Fetch worked; uploads failed or never ran |
| DB `with_key` ≈ S3 keys for those ids | Healthy link |
| S3 count **>** DB count | Often **orphan objects** (old uploads, no row in this DB) |
| S3 count **<** DB `with_key` | Missing objects, or keys point at deleted files |

### Orphans (example from this project)

Early objects uploaded during the first S3 test (~16 files around **2026-07-19 17:05 UTC**) lived in the **same bucket** but never matched the later **RDS** dataset.  
Those stay in S3 until deleted → S3 total can exceed DB row count by that orphan margin.

Check:

```bash
# DB
./deploy/aws-sql.sh "SELECT count(*)::int AS total, count(storage_key)::int AS with_key FROM media"

# S3
aws s3 ls s3://hashtag-tracker-storage-719905538532-ap-south-2-an/media/ --region ap-south-2 | wc -l
```

Compare **at the same moment** — both sides still grow as the worker runs.

---

## 7. How to tell “cron job” vs “deploy burst” vs “retry storm”

| Signal | Likely cause |
|---|---|
| Activity near 00:00 / 03:00 / 06:00 UTC (container TZ) with quiet gaps | Normal 3h cron |
| Burst right after `worker started` in logs | Boot / redeploy enqueue |
| Errors every 1–2 minutes: Meta / SQS | Visibility-timeout **retries**, not cron |
| Hundreds of S3 LastModified in ~10 minutes, one `worker started` before that | Single job batch upload |

Useful logs: CloudWatch `/ecs/hashtag-tracker-worker`  
Look for: `worker started`, Meta reduce-data, `asset upload failed`, `sqs poll/handle error`.

---

## 8. Production checklist (mental model)

1. **Cron** → enqueues at most on a **3-hour** grid (+ boot).  
2. **SQS** → may redeliver failed work **sooner**.  
3. **One job** → many DB rows + many S3 puts over **minutes**.  
4. **S3 timestamp** → end of each put, not Instagram post time.  
5. **Redeploy** → expect an **immediate** extra sync wave.

---

## 9. Observed production snapshot (reference)

Captured around the S3-upload-fix deploy window (evening 2026-07-19 IST):

| Item | Observation |
|---|---|
| Worker | Multiple `worker started` lines after ECS deploys |
| Before fix | Meta reduce-data errors; uploads often skipped when fetch threw |
| After fix | Pending assets uploaded; DB `with_key` caught up |
| Example DB window | `updated_at` ~ **18:25–18:36 UTC** for essentially all rows then present |
| S3 | Dense LastModified in the same local-time band (IST evening → midnight) |

Exact counts change as the pipeline continues; use the commands in §6 for live numbers.

---

## Bottom line

**Cron = “every 3 hours, start a batch.”**  
**S3 close timestamps = “files in that batch finished uploading close together.”**  

They are consistent. Dense S3 activity in a short window does **not** mean the cron interval is wrong.
