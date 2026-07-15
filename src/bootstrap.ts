import type { Knex } from 'knex';
import type { Config } from './config';
import { HashtagRepo, MediaRepo, HashtagRow } from './services/media-repo';
import { MetaClient } from './meta/client';
import { SyncService } from './services/sync';
import { createStorage } from './storage';
import { createQueue, Queue } from './queue';

export interface SyncContext {
  queue: Queue;
  sync: SyncService;
  ensureHashtag(name: string): Promise<{ hashtag: HashtagRow; hashtagId: string }>;
}

export function buildSyncContext(cfg: Config, db: Knex): SyncContext {
  const hashtags = new HashtagRepo(db);
  const media = new MediaRepo(db);
  const meta = new MetaClient({
    accessToken: cfg.META_ACCESS_TOKEN,
    userId: cfg.META_USER_ID,
    baseUrl: cfg.META_API_BASE,
    pageSize: cfg.META_PAGE_SIZE,
  });
  const storage = createStorage(cfg);
  const queue = createQueue(cfg);
  const sync = new SyncService({ hashtags, media, meta, storage, maxItems: cfg.SYNC_MAX_ITEMS });

  async function ensureHashtag(name: string): Promise<{ hashtag: HashtagRow; hashtagId: string }> {
    const hashtag = await hashtags.findByName(name);
    if (!hashtag) throw new Error(`hashtag ${name} not seeded — run npm run db:migrate`);
    if (hashtag.meta_hashtag_id) return { hashtag, hashtagId: hashtag.meta_hashtag_id };
    const hashtagId = await meta.searchHashtag(name);
    await hashtags.setMetaId(hashtag.id, hashtagId);
    return { hashtag, hashtagId };
  }

  return { queue, sync, ensureHashtag };
}
