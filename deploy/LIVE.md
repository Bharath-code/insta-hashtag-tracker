# Live AWS deployment

**Region:** ap-south-2 (Hyderabad)  
**Account:** 719905538532  

## Public API

Use **http** (not https):

```
http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/hashtags?limit=5
http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/health
```

```bash
curl -sS 'http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com/hashtags?limit=5'
```

## Query private RDS (one command)

```bash
./deploy/aws-sql.sh --preset counts
./deploy/aws-sql.sh --preset recent --limit 5
./deploy/aws-sql.sh "SELECT count(*)::int AS n FROM media"
# or: npm run aws:sql -- --preset counts
```

## Find services in the console / query the DB

See **[`docs/aws-console-and-query.md`](../docs/aws-console-and-query.md)** for:

- Region checklist (why RDS looks “missing”)
- Console deep links for RDS, ECS, S3, SQS, Secrets
- How to query via API vs SQL / ECS
- Cost control commands

## Resources

| Resource | Name / ID |
|---|---|
| ECS cluster | `hashtag-tracker` |
| API service | `hashtag-tracker-api` |
| Worker service | `hashtag-tracker-worker` |
| ALB DNS | `hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com` |
| ECR | `719905538532.dkr.ecr.ap-south-2.amazonaws.com/hashtag-tracker` |
| RDS | `hashtag-tracker-pg` (private, not public) |
| RDS endpoint | `hashtag-tracker-pg.cv6oi2kiinlf.ap-south-2.rds.amazonaws.com:5432` |
| S3 | `hashtag-tracker-storage-719905538532-ap-south-2-an` |
| SQS | `hastag-tracker-queue` |
| Secrets | `hashtag-tracker/database-url`, `hashtag-tracker/meta-token` |

## Stop / start (cost control for demos)

Full runbook: **[`stop-start-demo.md`](stop-start-demo.md)**

```bash
# STOP (save money)
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 0
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 0
aws rds stop-db-instance --db-instance-identifier hashtag-tracker-pg

# START (before demo; wait for RDS available first)
aws rds start-db-instance --db-instance-identifier hashtag-tracker-pg
aws rds wait db-instance-available --db-instance-identifier hashtag-tracker-pg
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-api --desired-count 1
aws ecs update-service --cluster hashtag-tracker --service hashtag-tracker-worker --desired-count 1
```

API-only demo (no Meta): set **api=1**, **worker=0**.

## Notes

- Tasks run on **Fargate ARM64** (image built on Apple Silicon).
- RDS requires SSL; app enables TLS for `*.rds.amazonaws.com`.
- Worker uses task role for S3/SQS (no access keys in the task).
- ALB still costs a little even when ECS is 0 (see stop-start-demo.md).

Deployed: 2026-07-19
