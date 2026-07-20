#!/usr/bin/env bash
# Bring AWS stack back for a demo.
# Usage: ./deploy/start-demo.sh              # API + worker
#        ./deploy/start-demo.sh --api-only   # no Meta / no sync (cheaper, safer for borrowed token)
#        ./deploy/start-demo.sh --yes
#
# See deploy/stop-start-demo.md

set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}:/opt/homebrew/bin"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN 2>/dev/null || true
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-ap-south-2}"
export AWS_DEFAULT_REGION="${AWS_REGION}"

CLUSTER="${CLUSTER:-hashtag-tracker}"
API_SERVICE="${API_SERVICE:-hashtag-tracker-api}"
WORKER_SERVICE="${WORKER_SERVICE:-hashtag-tracker-worker}"
DB_ID="${DB_ID:-hashtag-tracker-pg}"
ALB_URL="${ALB_URL:-http://hashtag-tracker-alb-2099949170.ap-south-2.elb.amazonaws.com}"

API_ONLY=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --api-only) API_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
  esac
done

WORKER_COUNT=1
if [[ "$API_ONLY" -eq 1 ]]; then
  WORKER_COUNT=0
fi

echo "Profile=${AWS_PROFILE} Region=${AWS_REGION}"
echo "Will start RDS ${DB_ID}, then ECS api=1 worker=${WORKER_COUNT}"
if [[ "$API_ONLY" -eq 1 ]]; then
  echo "(API-only: existing DB data only; no Meta sync)"
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

STATUS=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text)

echo "→ RDS current status: ${STATUS}"
if [[ "$STATUS" == "stopped" ]]; then
  echo "→ Starting RDS (often 5–10+ minutes)..."
  aws rds start-db-instance --db-instance-identifier "$DB_ID" --output text --query 'DBInstance.DBInstanceStatus'
elif [[ "$STATUS" == "available" ]]; then
  echo "→ RDS already available"
elif [[ "$STATUS" == "starting" ]]; then
  echo "→ RDS already starting"
else
  echo "→ RDS status=${STATUS}; waiting until available if possible..."
fi

echo "→ Waiting for RDS available..."
aws rds wait db-instance-available --db-instance-identifier "$DB_ID"
echo "→ RDS is available"

echo "→ Scaling ECS..."
aws ecs update-service --cluster "$CLUSTER" --service "$API_SERVICE" --desired-count 1 \
  --output text --query 'service.serviceName'
aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SERVICE" --desired-count "$WORKER_COUNT" \
  --output text --query 'service.serviceName'

echo "→ Waiting for services to stabilize (may take a few minutes)..."
if [[ "$WORKER_COUNT" -eq 1 ]]; then
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$API_SERVICE" "$WORKER_SERVICE" || true
else
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$API_SERVICE" || true
fi

echo ""
echo "Status:"
aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" "$WORKER_SERVICE" \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount}' --output table || true

echo ""
echo "Smoke tests (HTTP only):"
CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "${ALB_URL}/health" || echo "fail")
echo "  GET /health → ${CODE}"
CODE2=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "${ALB_URL}/hashtags?limit=1" || echo "fail")
echo "  GET /hashtags?limit=1 → ${CODE2}"

echo ""
echo "API: ${ALB_URL}/hashtags?limit=5"
echo "Park later with: ./deploy/stop-demo.sh"
