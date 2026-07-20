# Stop AWS for cost savings / Start for demos

Use this when you are **not** demoing (Meta token is temporary, AWS bills add up).  
All commands assume **region `ap-south-2`** and admin/`default` profile (browser login).

## Easiest: bash scripts

```bash
# After demo — park stack
./deploy/stop-demo.sh
./deploy/stop-demo.sh --yes              # no prompt
./deploy/stop-demo.sh --yes --purge-queue

# Before demo — bring stack back
./deploy/start-demo.sh
./deploy/start-demo.sh --yes
./deploy/start-demo.sh --yes --api-only  # no worker / no Meta (safest for borrowed token)
```

Scripts: [`stop-demo.sh`](stop-demo.sh), [`start-demo.sh`](start-demo.sh).

Manual CLI steps below if you prefer not to use the scripts.

```bash
export PATH="$HOME/.local/bin:$PATH:/opt/homebrew/bin"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
export AWS_PROFILE=default
export AWS_REGION=ap-south-2
export AWS_DEFAULT_REGION=ap-south-2
```

Related: [`LIVE.md`](LIVE.md), [`../docs/aws-console-and-query.md`](../docs/aws-console-and-query.md).

---

## What costs money when idle

| Resource | Idle cost | Can “pause”? |
|---|---|---|
| **ECS Fargate** (api + worker) | High if `desiredCount ≥ 1` | **Yes** — set desired count **0** |
| **RDS** `hashtag-tracker-pg` | High (instance hours) | **Yes** — **stop** instance |
| **ALB** | ~constant hourly charge | **No pause** — leave or **delete** (see §4) |
| **S3** | Pennies (storage) | Leave |
| **SQS / Secrets / ECR / logs** | Very low | Leave |

**Biggest wins when stopping:** ECS → 0, then **stop RDS**.  
**Still bills if left running:** ALB (unless deleted).

---

## 1. STOP everything (after a demo)

### Step A — Scale ECS to zero (immediate)

```bash
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api \
  --desired-count 0 --region ap-south-2

aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker \
  --desired-count 0 --region ap-south-2
```

Check:

```bash
aws ecs describe-services --cluster hashtag-tracker \
  --services hashtag-tracker-api hashtag-tracker-worker \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount}' \
  --output table
```

Expect `desired=0`, `running=0` after a minute or two.

### Step B — Stop RDS (saves most remaining compute cost)

```bash
aws rds stop-db-instance --db-instance-identifier hashtag-tracker-pg --region ap-south-2
```

Wait until stopped:

```bash
aws rds describe-db-instances --db-instance-identifier hashtag-tracker-pg \
  --query 'DBInstances[0].DBInstanceStatus' --output text
# want: stopped
```

**RDS stop limits (important):**

- You can usually keep an instance **stopped up to 7 days**; AWS may **auto-start** it after that.  
- Storage (and some extras) can still incur a small charge while stopped.  
- Starting again can take **several minutes**.

### Step C — Optional: empty the SQS queue (avoid surprise work on wake)

Only if you do not care about pending sync messages:

```bash
aws sqs purge-queue \
  --queue-url https://sqs.ap-south-2.amazonaws.com/719905538532/hastag-tracker-queue \
  --region ap-south-2
```

(Purge is allowed once per 60 seconds.)

### Step D — Do **not** need to delete

Leave in place for easy restore:

- S3 bucket (media files)  
- ECR images  
- Secrets (`hashtag-tracker/database-url`, `hashtag-tracker/meta-token`)  
- Security groups, cluster definition, task definitions  
- ALB (unless you want max savings — §4)

### One-liner stop (A + B)

```bash
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 0
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 0
aws rds stop-db-instance --db-instance-identifier hashtag-tracker-pg
```

---

## 2. START for a demo

Order matters: **RDS first**, then ECS.

### Step A — Start RDS

```bash
aws rds start-db-instance --db-instance-identifier hashtag-tracker-pg --region ap-south-2
```

Wait until available (often 5–10+ minutes):

```bash
aws rds wait db-instance-available --db-instance-identifier hashtag-tracker-pg
aws rds describe-db-instances --db-instance-identifier hashtag-tracker-pg \
  --query 'DBInstances[0].{status:DBInstanceStatus,endpoint:Endpoint.Address}' --output table
```

### Step B — Confirm Meta token still valid

Secrets Manager → `hashtag-tracker/meta-token`  
If the assignment token expired, put a new value:

```bash
# only when you have a fresh token
aws secretsmanager put-secret-value \
  --secret-id hashtag-tracker/meta-token \
  --secret-string 'PASTE_NEW_TOKEN_HERE' \
  --region ap-south-2
```

API can serve **existing** DB data without Meta.  
**Worker** needs a valid token only if you want a live sync during the demo.

### Step C — Scale ECS back up

```bash
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api \
  --desired-count 1 --region ap-south-2

aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker \
  --desired-count 1 --region ap-south-2
```

Wait until stable:

```bash
aws ecs wait services-stable --cluster hashtag-tracker \
  --services hashtag-tracker-api hashtag-tracker-worker
```

### Step D — Smoke test

```bash
# HTTP only (not https)
curl -sS -o /dev/null -w "%{http_code}\n" \
  'http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/health'

curl -sS \
  'http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/hashtags?limit=3' | head -c 400
echo
```

Optional DB check:

```bash
./deploy/aws-sql.sh --preset counts
```

### One-liner start (after RDS is available)

```bash
aws rds start-db-instance --db-instance-identifier hashtag-tracker-pg
aws rds wait db-instance-available --db-instance-identifier hashtag-tracker-pg
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 1
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 1
```

---

## 3. Demo-only worker (optional)

If you only need the **API** to show existing data (no Meta calls, less risk):

```bash
# API on, worker off
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 1
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 0
```

Then `GET /hashtags` still works from Postgres; no 3h sync / Meta / S3 writes.

---

## 4. ALB cost (still bills when ECS is 0)

Stopping ECS **does not stop ALB charges**.

| Option | Pros | Cons |
|---|---|---|
| **Leave ALB** | URL stays the same; fast demo | ~fixed monthly ALB cost |
| **Delete ALB** | Saves ALB money | Must recreate ALB + target group + listener + reattach service |

For most portfolio demos, **leave ALB**, stop **ECS + RDS**.

If you need maximum savings and are OK recreating load balancing later, delete ALB only when you know how to rebuild it (or re-run deploy notes in `deploy/README.md`).

---

## 5. What is preserved while stopped

| Data | Kept? |
|---|---|
| Postgres data (after stop, not delete) | **Yes** |
| S3 media objects | **Yes** |
| ECR images | **Yes** |
| Task definitions / cluster name | **Yes** |
| Secrets | **Yes** |
| Running Fargate tasks | No (scaled to 0) |
| Live API while stopped | **No** (until start) |

Do **not** run `delete-db-instance` or empty the S3 bucket unless you intend to destroy the project.

---

## 6. Status cheat sheet

```bash
# ECS
aws ecs describe-services --cluster hashtag-tracker \
  --services hashtag-tracker-api hashtag-tracker-worker \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount}' --output table

# RDS
aws rds describe-db-instances --db-instance-identifier hashtag-tracker-pg \
  --query 'DBInstances[0].DBInstanceStatus' --output text

# API (only when ECS+RDS up)
curl -sS -w "\n%{http_code}\n" \
  'http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/health'
```

| RDS status | Meaning |
|---|---|
| `available` | Ready for demo |
| `stopping` / `starting` | Wait |
| `stopped` | Parked for cost |

---

## 7. Suggested habit

| When | Action |
|---|---|
| Demo finished | STOP: ECS 0 + stop RDS (same day) |
| Before interview | START: RDS → wait → ECS 1 → curl health (~10–15 min budget) |
| Demo API only | API=1, worker=0 |
| Token expired | Update Secrets Manager; API-only demo still works with existing data |

---

## 8. Nuclear option (tear down project)

Only if you are done forever and accept data loss:

- Scale ECS to 0  
- `delete-db-instance` (final snapshot optional)  
- Delete ALB, target group  
- Optionally empty/delete S3, SQS, ECR, secrets  

Prefer **stop** over **delete** for portfolio reuse.

---

## Bottom line

**Stop for cost:**

```bash
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 0
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 0
aws rds stop-db-instance --db-instance-identifier hashtag-tracker-pg
```

**Start for demo:**

```bash
aws rds start-db-instance --db-instance-identifier hashtag-tracker-pg
aws rds wait db-instance-available --db-instance-identifier hashtag-tracker-pg
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 1
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 1
# then curl the ALB health + /hashtags URLs in LIVE.md
```
