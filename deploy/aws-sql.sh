#!/usr/bin/env bash
# One-command SQL against private RDS via a Fargate task.
# DATABASE_URL comes from Secrets Manager (task definition) — never printed.
#
# Usage:
#   ./deploy/aws-sql.sh --preset counts
#   ./deploy/aws-sql.sh --preset recent --limit 5
#   ./deploy/aws-sql.sh "SELECT id, media_type FROM media ORDER BY posted_at DESC LIMIT 5"
#
# Safety: container allows read-only SQL by default.
# Writes: ./deploy/aws-sql.sh --write "UPDATE ..."  (also needs SQL_ALLOW_WRITE in container)

set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}:/opt/homebrew/bin"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN 2>/dev/null || true
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-ap-south-2}"
export AWS_DEFAULT_REGION="${AWS_REGION}"

CLUSTER="${CLUSTER:-hashtag-tracker}"
TASK_FAMILY="${TASK_FAMILY:-hashtag-tracker-migrate}"
CONTAINER_NAME="${CONTAINER_NAME:-migrate}"
SUBNETS="${SUBNETS:-subnet-0ad301ab1d3335a0b,subnet-02084543242ba0487}"
SECURITY_GROUPS="${SECURITY_GROUPS:-sg-0475f39b69fd4458b}"
LOG_GROUP="${LOG_GROUP:-/ecs/hashtag-tracker-migrate}"

usage() {
  cat <<'EOF'
Usage:
  ./deploy/aws-sql.sh --preset counts
  ./deploy/aws-sql.sh --preset recent --limit 5
  ./deploy/aws-sql.sh --preset hashtags
  ./deploy/aws-sql.sh "SELECT count(*)::int AS n FROM media"

Options:
  --preset NAME   counts | hashtags | recent
  --limit N       row cap for --preset recent (default 100 in container)
  --write         allow DML (still blocked unless container gets SQL_ALLOW_WRITE=1)
  -h, --help      this help
EOF
  exit 2
}

ALLOW_WRITE=0
PRESET=""
LIMIT=""
SQL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      PRESET="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --write)
      ALLOW_WRITE=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      if [[ -n "$SQL" ]]; then
        SQL+=" $1"
      else
        SQL="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$PRESET" && -z "$SQL" ]]; then
  usage
fi

# Build overrides JSON (command + optional SQL_QUERY env)
OVERRIDES=$(
  PRESET="$PRESET" LIMIT="$LIMIT" SQL="$SQL" ALLOW_WRITE="$ALLOW_WRITE" \
  CONTAINER_NAME="$CONTAINER_NAME" python3 - <<'PY'
import json, os

cmd = ["node", "dist/scripts/sql-query.js"]
env = []

preset = os.environ.get("PRESET") or ""
limit = os.environ.get("LIMIT") or ""
sql = os.environ.get("SQL") or ""
allow = os.environ.get("ALLOW_WRITE") == "1"
name = os.environ["CONTAINER_NAME"]

if preset:
    cmd += ["--preset", preset]
    if limit:
        cmd += ["--limit", limit]
if allow:
    cmd += ["--write"]
    env.append({"name": "SQL_ALLOW_WRITE", "value": "1"})
if sql:
    env.append({"name": "SQL_QUERY", "value": sql})

print(json.dumps({"containerOverrides": [{"name": name, "command": cmd, "environment": env}]}))
PY
)

echo "→ ECS SQL task cluster=${CLUSTER} taskDef=${TASK_FAMILY}"

TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_FAMILY" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUPS}],assignPublicIp=ENABLED}" \
  --overrides "$OVERRIDES" \
  --query 'tasks[0].taskArn' \
  --output text)

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  echo "Failed to start task (check IAM/network/task definition)" >&2
  exit 1
fi

echo "→ Task ${TASK_ARN}"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)
REASON=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)
TASK_ID="${TASK_ARN##*/}"
STREAM="migrate/migrate/${TASK_ID}"

# CloudWatch can lag a few seconds after the task stops — retry.
LOG_TEXT=""
for attempt in 1 2 3 4 5 6; do
  sleep 2
  LOG_TEXT=$(
    aws logs get-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name "$STREAM" \
      --start-from-head \
      --query 'events[].message' \
      --output text 2>/dev/null || true
  )
  if [[ "$LOG_TEXT" == *SQL_RESULT_BEGIN* ]]; then
    break
  fi
  LOG_TEXT=$(
    aws logs filter-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name-prefix "$STREAM" \
      --query 'events[].message' \
      --output text 2>/dev/null || true
  )
  if [[ "$LOG_TEXT" == *SQL_RESULT_BEGIN* ]]; then
    break
  fi
  echo "→ waiting for logs (attempt ${attempt}/6)..."
done

if [[ -z "${LOG_TEXT// }" || "$LOG_TEXT" != *SQL_RESULT_BEGIN* ]]; then
  LOG_TEXT=$(aws logs tail "$LOG_GROUP" --since 15m --format short 2>/dev/null || true)
fi

EXTRACT_OK=0
LOG_TEXT="$LOG_TEXT" python3 - <<'PY' && EXTRACT_OK=1
import os, sys
text = os.environ.get("LOG_TEXT", "").replace("\t", "\n")
start = text.find("SQL_RESULT_BEGIN")
end = text.rfind("SQL_RESULT_END")
if start == -1 or end == -1 or end <= start:
    sys.stderr.write(text[-4000:] if text.strip() else "(no logs)\n")
    sys.stderr.write("\nCould not find SQL_RESULT markers in logs.\n")
    sys.exit(1)
block = text[start + len("SQL_RESULT_BEGIN") : end].strip()
lines = []
for line in block.splitlines():
    # strip "aws logs tail" timestamps if present
    if len(line) > 25 and line[4] == "-" and "T" in line[:25]:
        parts = line.split(" ", 1)
        lines.append(parts[1] if len(parts) > 1 else line)
    else:
        lines.append(line)
print("\n".join(lines))
PY

if [[ "$EXTRACT_OK" -ne 1 ]]; then
  exit 1
fi

if [[ "$EXIT_CODE" != "0" && "$EXIT_CODE" != "None" ]]; then
  echo "→ Task failed exit=${EXIT_CODE} reason=${REASON}" >&2
  exit 1
fi
echo "→ done"
