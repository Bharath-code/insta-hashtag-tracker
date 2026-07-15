import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Knex } from 'knex';
import { getTestDb, resetDb } from './helpers/db';
import { buildSyncContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { MetaClient } from '../src/meta/client';

describe('ensureHashtag', () => {
  let db: Knex;
  const cfg = loadConfig({ DATABASE_URL: 'unused', META_ACCESS_TOKEN: 't', META_USER_ID: 'u' });

  beforeAll(async () => {
    db = getTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => db.destroy());

  it('resolves via Meta once, then serves the cached id', async () => {
    const search = vi.spyOn(MetaClient.prototype, 'searchHashtag').mockResolvedValue('h777');
    const ctx = buildSyncContext(cfg, db);
    const first = await ctx.ensureHashtag('matcha');
    expect(first.hashtagId).toBe('h777');
    const second = await ctx.ensureHashtag('matcha');
    expect(second.hashtagId).toBe('h777');
    expect(search).toHaveBeenCalledTimes(1);
    search.mockRestore();
  });

  it('throws for unseeded hashtag', async () => {
    const ctx = buildSyncContext(cfg, db);
    await expect(ctx.ensureHashtag('unknown')).rejects.toThrow(/not seeded/);
  });
});
