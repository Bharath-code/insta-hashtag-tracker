# AWS deploy (ECS Fargate) — hireable path

Ship the **same Docker image** three ways:

| Task | Container command | Notes |
|---|---|---|
| **API** | `node dist/api.js` | Behind ALB, port 3000 |
| **Worker** | `node dist/worker.js` | No inbound; SQS + Meta + S3 |
| **Migrate** (one-off) | `node dist/db/migrate.js` | Run once per release before traffic |

Full portfolio rationale: [`docs/aws-portfolio-deploy.md`](../docs/aws-portfolio-deploy.md).  
Networking checklist: [`docs/aws-container-deploy.md`](../docs/aws-container-deploy.md).

---

## 1. Build and push image

```bash
# From repo root
export AWS_REGION=ap-south-2
export AWS_ACCOUNT_ID=719905538532
export ECR_REPO=hashtag-tracker
export IMAGE_TAG=$(git rev-parse --short HEAD)

# Create repo once
aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" 2>/dev/null || true

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

docker build -t "${ECR_REPO}:${IMAGE_TAG}" .
docker tag "${ECR_REPO}:${IMAGE_TAG}" \
  "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"
docker push \
  "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"
```

---

## 2. Production environment variables

Set on the **task definition** (non-secrets as plain env; secrets from Secrets Manager ARNs):

| Name | Value |
|---|---|
| `QUEUE_DRIVER` | `sqs` |
| `STORAGE_DRIVER` | `s3` |
| `SQS_QUEUE_URL` | your queue URL |
| `S3_BUCKET` | `hashtag-tracker-storage-719905538532-ap-south-2-an` |
| `AWS_REGION` | `ap-south-2` |
| `META_USER_ID` | Instagram business account id |
| `META_API_BASE` | `https://graph.facebook.com/v24.0` |
| `META_PAGE_SIZE` | `3` |
| `SYNC_MAX_ITEMS` | `500` |
| `PORT` | `3000` |
| `DATABASE_URL` | **secret** |
| `META_ACCESS_TOKEN` | **secret** |

Do **not** bake `.env` into the image. Prefer **task IAM role** for S3/SQS (no access keys on the task).

---

## 3. One-time AWS resources

1. VPC (public + private subnets, 2 AZs) + NAT (or VPC endpoints for S3/SQS)  
2. Security groups: ALB → API:3000 → RDS:5432; Worker → RDS + egress HTTPS  
3. RDS Postgres 16, private  
4. SQS + DLQ (you may already have the queue)  
5. S3 bucket (you may already have it)  
6. Secrets Manager secrets for DB URL + Meta token  
7. ECS cluster (Fargate)  
8. ALB + target group (health check: `GET /hashtags?limit=1` → 200)  
9. IAM task execution role (ECR pull, logs, secrets)  
10. IAM task role (S3 + SQS for **worker**; API needs almost none beyond DB via network)

Templates for task definitions: [`ecs/`](ecs/).

---

## 4. Deploy sequence

```text
1. Push image to ECR
2. Run migrate as one-off ECS task (start:migrate)
3. Update API service → new task definition
4. Update Worker service → new task definition
5. Smoke: curl https://<alb>/hashtags?limit=5
6. Confirm S3 media/ objects and CloudWatch logs
```

---

## 5. Local image smoke (optional)

Still needs network to RDS/SQS/S3/Meta if you point at AWS:

```bash
docker build -t hashtag-tracker:local .
# migrate against whatever DATABASE_URL is in .env
docker run --rm --env-file .env hashtag-tracker:local node dist/db/migrate.js
docker run --rm -p 3000:3000 --env-file .env hashtag-tracker:local
```

For pure AWS, use ECS only — no local runtime required for production.

---

## 6. Interview talking points

- Same image, two services: **read path isolated from ingestion**  
- **SQS** for async jobs; **S3** because Meta media URLs expire  
- **Idempotent** upserts (media id PK) under at-least-once delivery  
- Secrets in **Secrets Manager**; least-privilege **task roles**  
- Next evolution: EventBridge schedule + Lambda worker (see portfolio doc)
