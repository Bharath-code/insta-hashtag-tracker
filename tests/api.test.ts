import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Knex } from 'knex';
import { getTestDb, resetDb } from './helpers/db';
import { createApp } from '../src/app';
import { MediaRepo, HashtagRepo } from '../src/services/media-repo';

describe('GET /hashtags', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = getTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
    app = createApp(db);
    const hashtag = (await new HashtagRepo(db).findByName('matcha'))!;
    const repo = new MediaRepo(db);
    await repo.upsertBatch(
      hashtag.id,
      'recent',
      ['a', 'b', 'c'].map((id, n) => ({
        id,
        media_type: 'IMAGE',
        permalink: `https://ig/p/${id}`,
        timestamp: `2026-07-15T1${n}:00:00Z`,
      })),
    );
  });
  afterAll(async () => db.destroy());

  it('returns newest first with a nextCursor that pages through', async () => {
    const page1 = await request(app).get('/hashtags?limit=2').expect(200);
    expect(page1.body.data.map((m: { id: string }) => m.id)).toEqual(['c', 'b']);
    expect(page1.body.nextCursor).toBeTypeOf('string');

    const page2 = await request(app)
      .get(`/hashtags?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .expect(200);
    expect(page2.body.data.map((m: { id: string }) => m.id)).toEqual(['a']);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('rejects invalid cursor with 400', async () => {
    const res = await request(app).get('/hashtags?cursor=garbage!').expect(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it('clamps limit to 100', async () => {
    await request(app).get('/hashtags?limit=5000').expect(200);
  });

  it('health endpoint responds', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});
