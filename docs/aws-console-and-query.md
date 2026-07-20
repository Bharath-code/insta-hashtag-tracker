# AWS console map + how to query the database

Quick reference for the **live hashtag-tracker** deployment.  
Region is always **`ap-south-2` (Asia Pacific – Hyderabad)** unless you redeploy elsewhere.

Related: [`deploy/LIVE.md`](../deploy/LIVE.md) (public URL + resource names), [`db-access.md`](db-access.md) (local Docker Postgres only), [`worker-cron-and-s3-timing.md`](worker-cron-and-s3-timing.md) (why S3 times cluster vs 3h cron).

---

## 1. Set the region first

In the AWS Console, top-right region selector must be:

**Asia Pacific (Hyderabad) — `ap-south-2`**

If you are in Mumbai (`ap-south-1`), N. Virginia (`us-east-1`), etc., **RDS / ECS will look empty**.

CLI:

```bash
export AWS_PROFILE=default   # browser login session, or your admin profile
export AWS_REGION=ap-south-2
export AWS_DEFAULT_REGION=ap-south-2
# Do not leave IAM access keys in the shell if they override this profile
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
```

---

## 2. Where to find each service

| What | Console path | Name / ID |
|---|---|---|
| **Postgres DB** | RDS → Databases | `hashtag-tracker-pg` |
| **ECS cluster** | ECS → Clusters | `hashtag-tracker` |
| **API service** | Cluster → Services | `hashtag-tracker-api` |
| **Worker service** | Cluster → Services | `hashtag-tracker-worker` |
| **Load balancer** | EC2 → Load balancers | `hashtag-tracker-alb` |
| **Container images** | ECR → Repositories | `hashtag-tracker` |
| **Media files** | S3 → Buckets | `hashtag-tracker-storage-719905538532-ap-south-2-an` |
| **Job queue** | SQS → Queues | `hastag-tracker-queue` (spelling as created) |
| **DB URL secret** | Secrets Manager | `hashtag-tracker/database-url` |
| **Meta token secret** | Secrets Manager | `hashtag-tracker/meta-token` |

### Deep links (open after region is ap-south-2)

| Service | URL |
|---|---|
| RDS databases | https://ap-south-2.console.aws.amazon.com/rds/home?region=ap-south-2#databases: |
| ECS cluster services | https://ap-south-2.console.aws.amazon.com/ecs/v2/clusters/hashtag-tracker/services?region=ap-south-2 |
| ALB | https://ap-south-2.console.aws.amazon.com/ec2/home?region=ap-south-2#LoadBalancers: |
| S3 bucket | https://s3.console.aws.amazon.com/s3/buckets/hashtag-tracker-storage-719905538532-ap-south-2-an?region=ap-south-2 |
| SQS queues | https://ap-south-2.console.aws.amazon.com/sqs/v3/home?region=ap-south-2#/queues |
| Secrets Manager | https://ap-south-2.console.aws.amazon.com/secretsmanager/listsecrets?region=ap-south-2 |
| ECR repo | https://ap-south-2.console.aws.amazon.com/ecr/repositories/private/719905538532/hashtag-tracker?region=ap-south-2 |
| CloudWatch logs (API) | https://ap-south-2.console.aws.amazon.com/cloudwatch/home?region=ap-south-2#logsV2:log-groups/log-group/$252Fecs$252Fhashtag-tracker-api |
| CloudWatch logs (worker) | https://ap-south-2.console.aws.amazon.com/cloudwatch/home?region=ap-south-2#logsV2:log-groups/log-group/$252Fecs$252Fhashtag-tracker-worker |

### Confirm from CLI

```bash
aws rds describe-db-instances --db-instance-identifier hashtag-tracker-pg \
  --query 'DBInstances[0].{status:DBInstanceStatus,endpoint:Endpoint.Address,public:PubliclyAccessible}' \
  --output table

aws ecs describe-services --cluster hashtag-tracker \
  --services hashtag-tracker-api hashtag-tracker-worker \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}' \
  --output table
```

---

## 3. RDS details (when you open the DB)

| Field | Value |
|---|---|
| Identifier | `hashtag-tracker-pg` |
| Engine | PostgreSQL 16 |
| Instance class | `db.t4g.micro` |
| Endpoint | `hashtag-tracker-pg.cv6oi2kiinlf.ap-south-2.rds.amazonaws.com` |
| Port | `5432` |
| DB name | `hashtag` |
| Master user | `hashtag` |
| Public access | **No** (private VPC only) |
| SSL | Required |

Password and full URL: Secrets Manager → **`hashtag-tracker/database-url`** → Retrieve secret value.  
**Never commit that secret or paste it into chat/GitHub.**

---

## 4. How to query data

### A. One-command SQL via ECS (safe, private RDS)

Runs a short Fargate task in the VPC. Password stays in Secrets Manager and is never printed.

```bash
# From repo root (needs AWS CLI + login / admin profile in ap-south-2)
./deploy/aws-sql.sh --preset counts
./deploy/aws-sql.sh --preset hashtags
./deploy/aws-sql.sh --preset recent --limit 5
./deploy/aws-sql.sh "SELECT id, media_type, source FROM media ORDER BY posted_at DESC LIMIT 5"

# npm alias
npm run aws:sql -- --preset counts
```

**Safety defaults:** `SELECT` / `WITH` / `SHOW` / `EXPLAIN` only, single statement, row cap.  
Writes need `--write` and are still discouraged.

Local Postgres (docker compose) without ECS:

```bash
npm run db:sql -- --preset counts
```

### B. Public API (no DB client needed)

```bash
# Health
curl -sS 'http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/health'

# Media feed (HTTP only — not https)
curl -sS 'http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/hashtags?limit=5'

# Pretty-print
curl -sS 'http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/hashtags?limit=5' \
  | python3 -m json.tool | head -60
```

Browser tip: use **`http://`** + path `/hashtags?limit=5`.  
`https://` will hang/fail (no HTTPS listener on the ALB yet).

### C. SQL against RDS from your laptop (why tools fail)

RDS is **not publicly accessible**. TablePlus / DBeaver / `psql` from your laptop will **not** connect unless you:

- add a bastion / SSM host in the VPC, or  
- use a VPN / tunnel, or  
- temporarily make the instance public (not recommended).

### D. Useful SQL (once you have a connection inside the VPC)

```sql
-- Counts
SELECT count(*) FROM hashtags;
SELECT count(*) FROM media;
SELECT count(*) FROM media WHERE storage_key IS NOT NULL AS with_assets;

-- Hashtag row
SELECT id, name, meta_hashtag_id, last_synced_at FROM hashtags;

-- Newest posts
SELECT id, media_type, source, like_count, storage_key, posted_at
FROM media
ORDER BY posted_at DESC, id DESC
LIMIT 20;
```

### E. Secrets Manager (connection string only)

1. Console → Secrets Manager (ap-south-2)  
2. Open `hashtag-tracker/database-url`  
3. **Retrieve secret value**  
4. Use that URL only from a client **inside the VPC** (or tunnel)

### F. App logs (debug without SQL)

- CloudWatch → Log groups → `/ecs/hashtag-tracker-api`  
- CloudWatch → Log groups → `/ecs/hashtag-tracker-worker`  
- CloudWatch → Log groups → `/ecs/hashtag-tracker-migrate`  

```bash
aws logs tail /ecs/hashtag-tracker-api --since 30m --format short
aws logs tail /ecs/hashtag-tracker-worker --since 30m --format short
```

---

## 5. S3 media objects

Console: S3 → `hashtag-tracker-storage-719905538532-ap-south-2-an` → prefix **`media/`**

```bash
aws s3 ls s3://hashtag-tracker-storage-719905538532-ap-south-2-an/media/ --region ap-south-2 | head
```

`media.storage_key` in Postgres points at keys like `media/<id>.jpg` or `media/<id>.mp4`.

---

## 6. Common “I can’t find it” mistakes

| Mistake | Fix |
|---|---|
| Wrong region | Switch to **ap-south-2 (Hyderabad)** |
| Looking under DynamoDB / DocumentDB | This project uses **RDS PostgreSQL** |
| Empty RDS list | Confirm account `719905538532` and region |
| TablePlus connection timeout | Expected — DB is **private** |
| Browser “still loading” on ALB | Use **http** not https; path `/hashtags?limit=5` |
| Queue name search “hashtag” | Queue is spelled **`hastag-tracker-queue`** |

---

## 7. Cost control (when not demoing)

```bash
export AWS_PROFILE=default AWS_REGION=ap-south-2
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 0
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 0

# Optional: stop RDS (still some storage cost; start later before demo)
# aws rds stop-db-instance --db-instance-identifier hashtag-tracker-pg
```

Start services again for a demo:

```bash
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 1
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 1
# If RDS was stopped: aws rds start-db-instance --db-instance-identifier hashtag-tracker-pg
```

---

## 8. Account reminder

| Item | Value |
|---|---|
| Account ID | `719905538532` |
| Deploy region | `ap-south-2` |
| Public API host | `hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com` |

If you recreate ALB/RDS, update this file and `deploy/LIVE.md` with the new endpoint DNS.
