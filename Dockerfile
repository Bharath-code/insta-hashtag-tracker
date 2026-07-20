# Multi-stage production image for API + worker (same image, different CMD).
# Build (Apple Silicon → Fargate ARM64):
#   docker build -t hashtag-tracker:local .
# For amd64 Fargate instead:
#   docker build --platform linux/amd64 -t hashtag-tracker:local .
# API:    docker run --rm -p 3000:3000 --env-file .env hashtag-tracker:local
# Worker: docker run --rm --env-file .env hashtag-tracker:local node dist/worker.js
# Migrate: docker run --rm --env-file .env hashtag-tracker:local node dist/db/migrate.js

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Fargate/task definitions set real values; these are safe defaults only.
ENV PORT=3000

RUN useradd --system --uid 1001 --create-home appuser

COPY --from=build --chown=appuser:appuser /app/package.json /app/package-lock.json ./
COPY --from=build --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appuser /app/dist ./dist

USER appuser
EXPOSE 3000

# Default to API; override CMD for worker / migrate in ECS task definitions.
CMD ["node", "dist/api.js"]
