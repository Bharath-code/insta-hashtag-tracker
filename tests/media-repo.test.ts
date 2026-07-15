import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Knex } from 'knex';
import { getTestDb, resetDb } from './helpers/db';
import { MediaRepo, HashtagRepo, MediaInput } from '../src/services/media-repo';
import { encodeCursor, decodeCursor } from '../src/services/cursor';

function item(id: string, ts: string, likes = 1): MediaInput {
  return {
    id,
    media_type: 'IMAGE',
    permalink: `https://instagram.com/p/${id}`,
    timestamp: ts,
    media_url: `https://cdn.example.com/${id}.jpg`,
    like_count: likes,
    comments_count: 0,
  };
}

describe('MediaRepo', () => {
  let db: Knex;
  let repo: MediaRepo;
  let hashtagId: number;

  beforeAll(async () => {
    db = getTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
    repo = new MediaRepo(db);
    const row = await new HashtagRepo(db).findByName('matcha');
    hashtagId = row!.id;
  });
  afterAll(async () => db.destroy());

  it('upserting the same media twice yields one row with refreshed counts', async () => {
    await repo.upsertBatch(hashtagId, 'top', [item('m1', '2026-07-15T10:00:00Z', 5)]);
    await repo.upsertBatch(hashtagId, 'recent', [item('m1', '2026-07-15T10:00:00Z', 9)]);
    const rows = await db('media');
    expect(rows).toHaveLength(1);
    expect(rows[0].like_count).toBe(9);
    expect(rows[0].source).toBe('top');
  });

  it('lists newest-first and paginates with keyset cursor', async () => {
    await repo.upsertBatch(hashtagId, 'recent', [
      item('a', '2026-07-15T10:00:00Z'),
      item('b', '2026-07-15T11:00:00Z'),
      item('c', '2026-07-15T12:00:00Z'),
    ]);
    const page1 = await repo.listPage(2);
    expect(page1.map((r) => r.id)).toEqual(['c', 'b']);
    const cursor = decodeCursor(
      encodeCursor({ p: page1[1].posted_at.toISOString(), i: page1[1].id }),
    )!;
    const page2 = await repo.listPage(2, cursor);
    expect(page2.map((r) => r.id)).toEqual(['a']);
  });

  it('finds pending assets and clears them via setStorageKey', async () => {
    await repo.upsertBatch(hashtagId, 'recent', [item('m2', '2026-07-15T10:00:00Z')]);
    const pending = await repo.findPendingAssets(hashtagId);
    expect(pending).toEqual([{ id: 'm2', media_url: 'https://cdn.example.com/m2.jpg' }]);
    await repo.setStorageKey('m2', 'media/m2.jpg');
    expect(await repo.findPendingAssets(hashtagId)).toEqual([]);
  });

  it('handles empty batch without error', async () => {
    await expect(repo.upsertBatch(hashtagId, 'top', [])).resolves.toBeUndefined();
  });
});

describe('HashtagRepo', () => {
  let db: Knex;
  beforeAll(async () => {
    db = getTestDb();
    await resetDb(db);
  });
  afterAll(async () => db.destroy());

  it('sets meta id and last synced', async () => {
    const repo = new HashtagRepo(db);
    const row = (await repo.findByName('matcha'))!;
    await repo.setMetaId(row.id, '999');
    await repo.setLastSynced(row.id);
    const updated = (await repo.findByName('matcha'))!;
    expect(updated.meta_hashtag_id).toBe('999');
    expect(updated.last_synced_at).toBeInstanceOf(Date);
  });
});
