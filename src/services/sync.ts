import type { HashtagRepo, MediaRepo } from './media-repo';
import type { MetaClient } from '../meta/client';
import type { Storage } from '../storage';
import type { Job } from '../queue';

export const JOB_SYNC_TOP = 'SYNC_TOP_HASHTAG_MEDIA';
export const JOB_SYNC_RECENT = 'SYNC_RECENT_HASHTAG_MEDIA';

export interface SyncDeps {
  hashtags: Pick<HashtagRepo, 'findByName' | 'setLastSynced'>;
  media: Pick<MediaRepo, 'upsertBatch' | 'findPendingAssets' | 'setStorageKey'>;
  meta: Pick<MetaClient, 'fetchHashtagMedia'>;
  storage: Storage;
  maxItems: number;
  assetConcurrency?: number;
  fetchFn?: typeof fetch;
}

export class SyncService {
  constructor(private readonly deps: SyncDeps) {}

  async run(job: Job): Promise<void> {
    const isTop = job.type === JOB_SYNC_TOP;
    const edge = isTop ? 'top_media' : 'recent_media';
    const source = isTop ? 'top' : 'recent';

    const hashtag = await this.deps.hashtags.findByName(job.payload.hashtag);
    if (!hashtag) throw new Error(`unknown hashtag: ${job.payload.hashtag}`);

    for await (const page of this.deps.meta.fetchHashtagMedia(
      job.payload.hashtagId,
      edge,
      this.deps.maxItems,
    )) {
      await this.deps.media.upsertBatch(hashtag.id, source, page);
    }

    await this.uploadPendingAssets(hashtag.id);
    await this.deps.hashtags.setLastSynced(hashtag.id);
  }

  private async uploadPendingAssets(hashtagId: number): Promise<void> {
    const queue = await this.deps.media.findPendingAssets(hashtagId);
    const concurrency = this.deps.assetConcurrency ?? 5;
    const workers = Array.from({ length: concurrency }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const key = await this.downloadAndStore(item.id, item.media_url);
          await this.deps.media.setStorageKey(item.id, key);
        } catch (err) {
          // One bad asset must never fail the batch; next sync retries it.
          console.error(`asset upload failed for media ${item.id}`, err);
        }
      }
    });
    await Promise.all(workers);
  }

  private async downloadAndStore(id: string, url: string): Promise<string> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`asset download failed with status ${res.status}`);
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const ext = contentType.includes('video') ? 'mp4' : 'jpg';
    const key = `media/${id}.${ext}`;
    await this.deps.storage.put(key, Buffer.from(await res.arrayBuffer()), contentType);
    return key;
  }
}
