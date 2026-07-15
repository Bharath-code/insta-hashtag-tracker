# Hashtag Tracking Assignment

## Overview

This assignment is based on a real feature our team has built for tracking Instagram hashtag media.

Your task is to design and implement a scalable ingestion pipeline: fetch media from Meta, store it in Postgres, upload assets to storage, avoid duplicates, and expose a paginated read API.

Meta's `top_media` and `recent_media` endpoints are paginated. A single hashtag can return a large volume of media across pages — plan your ingestion to handle pagination and up to **500 media items per sync**.

We do not expect a production-ready system in the time available. We are looking for clear engineering judgment and a clean implementation.

## Requirements

Build a system that tracks the `matcha` hashtag. The system should:

- Be built using Express, TypeScript, and Postgres.
- Create all database tables through migrations.
- Track the hashtag `matcha`.
- Fetch and store top media for the hashtag.
- Periodically, every 3 hours, fetch and store recent media for the hashtag.
- Store media metadata in the database, such as:
    - media ID, caption, media type, media URL, permalink and more
    - Note: the above are suggestions; we want to see what you keep and leave out of the database and why. Feel free to add or remove fields.
- Download/upload media assets into storage.
- Avoid duplicate media records.
- Expose one paginated API to fetch stored hashtag media.

## Resources

Use the following credentials for the APIs below:

- Instagram page token: 
`EAAMQTKttZCYkBRZCNGoAf5UgYvhB9jcyn5x8bg3nVXVs6eUGSWEEqt7LeneITEQoYCzxVLgL120s1OPJtpjcNQrN8AzZBB4vo61WAQXarNWElcmrCZAQKdFTvZCIznu8eAvJcJO6NCSN84ly8rkM6M36fs0JIrUCrkPLEeGtFnxBL5e20PWCuekqZABQTfsjnQYjFKy1R7X6y3S3dhCjNvdUEo`
- Instagram business id (`user_id`): `17841413741308252`

Get the hashtag ID:

```bash
curl "<https://graph.facebook.com/v24.0/ig_hashtag_search?user_id=${user_id}&q=matcha&access_token=${access_token}>"
```

Get top media (use the hashtag id from the previous call):

```bash
curl "<https://graph.facebook.com/v24.0/${hashtag_id}/top_media?user_id=${user_id}&fields=id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count&limit=25&access_token=${access_token}>"
```

Get recent media (use the hashtag id from the previous call):

```bash
curl "<https://graph.facebook.com/v24.0/${hashtag_id}/recent_media?user_id=${user_id}&fields=id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count&limit=25&access_token=${access_token}>"
```

## Queue, Cron, And Storage

If you have AWS available, you can use:

- AWS SQS for background jobs
- AWS S3 for media storage
- AWS EventBridge/Lambda/Cron for scheduled recent media sync

**Note:** If you use cloud services, use AWS only. Do not use GCP, Azure, or other cloud providers.

If you do not want to use AWS, use local replacements:

- In-memory queue instead of SQS
- Node cron
- Local file storage instead of S3

Example local setup:

```jsx
queue.enqueue("SYNC_RECENT_HASHTAG_MEDIA", {
  hashtag: "matcha",
  hashtagId: "..."
});
```

```jsx
cron.schedule("0 */3 * * *", async () => {
  await queue.enqueue("SYNC_RECENT_HASHTAG_MEDIA", {
    hashtag: "matcha",
    hashtagId: "..."
  });
});
```

The important part is that your code should be structured so local implementations can later be replaced with AWS implementations.

## API Requirement

Create one paginated API on the path `GET /hashtags` to return stored media in descending order of creation time.

---

## AI Tool Usage

We are interested in how you use AI while building this assignment.

In `instructions.md`, add a section under the header `ai-usage` covering:

- Which AI tools you used (for example, Cursor, Claude, Codex)
- What you used them for
- What you reviewed, tested, or wrote yourself

Optionally, you can also share exported chat history from your AI sessions (Markdown,  or share links). Remove any sensitive information before sharing.

**If you share chat exports, your submission will be prioritized during review.**

## Deliverables

Share:

- Working code — share GitHub access to `saral-kalwani`, `pranav-getsaral`, and `nivekithan-saral`
- Create an `instructions.md` in the root with:
    - Setup instructions under the header `setup`
    - If any, environment variables under the header `vars`
    - If any, tradeoffs or shortcuts under the header `tradeoffs`
- Optionally, include exported AI chat history in an `ai-usage/` folder or share links in `instructions.md`
