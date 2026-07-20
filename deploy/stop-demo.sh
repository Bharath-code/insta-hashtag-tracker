#!/usr/bin/env bash
# Park AWS resources to save cost after a demo.
# Usage: ./deploy/stop-demo.sh
#        ./deploy/stop-demo.sh --purge-queue   # also empty SQS
#        ./deploy/stop-demo.sh --yes           # skip confirmation
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
QUEUE_URL="${QUEUE_URL:-https://sqs.ap-south-2.amazonaws.com/719905538532/hastag-tracker-queue}"

PURGE_QUEUE=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge-queue) PURGE_QUEUE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
  esac
done

echo "Profile=${AWS_PROFILE} Region=${AWS_REGION}"
echo "Will set ECS desiredCount=0 and stop RDS ${DB_ID}"
if [[ "$PURGE_QUEUE" -eq 1 ]]; then
  echo "Will also purge SQS queue"
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

echo "→ Scaling ECS services to 0..."
aws ecs update-service --cluster "$CLUSTER" --service "$API_SERVICE" --desired-count 0 --output text --query 'service.serviceName'
aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SERVICE" --desired-count 0 --output text --query 'service.serviceName'

echo "→ Stopping RDS (may take several minutes)..."
if aws rds stop-db-instance --db-instance-identifier "$DB_ID" --output text --query 'DBInstance.DBInstanceStatus' 2>/dev/null; then
  :
else
  STATUS=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo unknown)
  echo "  (stop skipped or failed; current status=${STATUS} — already stopped is OK)"
fi

if [[ "$PURGE_QUEUE" -eq 1 ]]; then
  echo "→ Purging SQS..."
  aws sqs purge-queue --queue-url "$QUEUE_URL" || echo "  purge failed (maybe rate-limited; ignore if idle)"
fi

echo ""
echo "Status:"
aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" "$WORKER_SERVICE" \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount}' --output table || true
aws rds describe-db-instances --db-instance-identifier "$DB_ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text || true

echo ""
echo "Done. ECS should go to running=0 shortly; RDS may show stopping → stopped."
echo "Note: ALB still incurs a small charge while left in place."
echo "Restore later with: ./deploy/start-demo.sh"
