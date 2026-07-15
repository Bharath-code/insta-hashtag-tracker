import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Knex } from 'knex';
import { getTestDb, resetDb } from './helpers/db';

describe('migrations and seed', () => {
  let db: Knex;
  beforeAll(async () => {
    db = getTestDb();
    await resetDb(db);
  });
  afterAll(async () => db.destroy());

  it('creates hashtags and media tables', async () => {
    expect(await db.schema.hasTable('hashtags')).toBe(true);
    expect(await db.schema.hasTable('media')).toBe(true);
  });

  it('seeds the matcha hashtag exactly once (idempotent)', async () => {
    await db.seed.run();
    const rows = await db('hashtags').where({ name: 'matcha' });
    expect(rows).toHaveLength(1);
    expect(rows[0].last_synced_at).toBeNull();
  });
});
