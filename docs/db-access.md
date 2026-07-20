# Database access reference

Where to find synced Instagram hashtag data after running this app.

## Connection

| Field | Value |
|---|---|
| Host | `localhost` |
| Port | `5432` |
| Database | `hashtag` |
| User | `postgres` |
| Password | `postgres` |
| URL | `postgres://postgres:postgres@localhost:5432/hashtag` |

Same values as `DATABASE_URL` in `.env` / `.env.example`.

Start Postgres first:

```bash
docker compose up -d
```

## Tables

| Table | What it holds |
|---|---|
| `hashtags` | Tracked tags (e.g. `matcha`), Meta hashtag id, `last_synced_at` |
| `media` | Instagram posts/reels: id, caption, media_type, permalink, media_url, storage_key, like/comment counts, `posted_at`, source (`top` / `recent`) |

## CLI access

```bash
# Interactive SQL shell
docker compose exec postgres psql -U postgres -d hashtag

# List tables
docker compose exec -T postgres psql -U postgres -d hashtag -c "\dt"

# Hashtag row(s)
docker compose exec -T postgres psql -U postgres -d hashtag -c "SELECT * FROM hashtags;"

# Recent media (newest first)
docker compose exec -T postgres psql -U postgres -d hashtag -c "
SELECT id, media_type, source, like_count, storage_key, posted_at
FROM media
ORDER BY posted_at DESC, id DESC
LIMIT 10;
"

# Counts / upload status
docker compose exec -T postgres psql -U postgres -d hashtag -c "
SELECT
  (SELECT count(*) FROM hashtags) AS hashtags,
  (SELECT count(*) FROM media) AS media,
  (SELECT count(*) FROM media WHERE storage_key IS NOT NULL) AS with_assets,
  (SELECT count(*) FROM media WHERE storage_key IS NULL) AS pending_assets;
"
```

## GUI clients

Use TablePlus, DBeaver, pgAdmin, or a VS Code Postgres extension with:

`postgres://postgres:postgres@localhost:5432/hashtag`

## Local asset files (not in DB)

With `STORAGE_DRIVER=local`, media binaries are under:

```text
storage/media/<media_id>.jpg
storage/media/<media_id>.mp4
```

`media.storage_key` points at those paths (e.g. `media/18203763187315383.mp4`).

## HTTP API (same data)

```bash
curl 'http://localhost:3000/hashtags?limit=10'
# next page:
curl "http://localhost:3000/hashtags?limit=10&cursor=<nextCursor>"
```

Requires `npm run dev:api` (and data from `npm run sync:once` or the worker).
