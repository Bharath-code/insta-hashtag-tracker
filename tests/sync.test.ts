import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncService, JOB_SYNC_TOP, JOB_SYNC_RECENT, SyncDeps } from '../src/services/sync';
import type { MetaMedia } from '../src/meta/client';

const media = (id: string, url?: string): MetaMedia => ({
  id,
  media_type: 'IMAGE',
  permalink: `https://ig/p/${id}`,
  timestamp: '2026-07-15T10:00:00+0000',
  media_url: url,
});

function makeDeps(pages: MetaMedia[][], pending: Array<{ id: string; media_url: string }>) {
  const deps = {
    hashtags: {
      findByName: vi.fn().mockResolvedValue({ id: 7, name: 'matcha', meta_hashtag_id: 'h1', last_synced_at: null }),
      setLastSynced: vi.fn().mockResolvedValue(undefined),
    },
    media: {
      upsertBatch: vi.fn().mockResolvedValue(undefined),
      findPendingAssets: vi.fn().mockResolvedValue(pending),
      setStorageKey: vi.fn().mockResolvedValue(undefined),
    },
    meta: {
      fetchHashtagMedia: vi.fn().mockImplementation(async function* () {
        yield* pages;
      }),
    },
    storage: { put: vi.fn().mockResolvedValue(undefined) },
    maxItems: 500,
    fetchFn: vi.fn().mockResolvedValue(
      new Response(Buffer.from('img'), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    ) as unknown as typeof fetch,
  };
  return deps;
}

const job = (type: string) => ({ type, payload: { hashtag: 'matcha', hashtagId: 'h1' } });

describe('SyncService', () => {
  it('upserts each page with the right source and edge', async () => {
    const deps = makeDeps([[media('1')], [media('2')]], []);
    await new SyncService(deps as unknown as SyncDeps).run(job(JOB_SYNC_TOP));
    expect(deps.meta.fetchHashtagMedia).toHaveBeenCalledWith('h1', 'top_media', 500);
    expect(deps.media.upsertBatch).toHaveBeenNthCalledWith(1, 7, 'top', [media('1')]);
    expect(deps.media.upsertBatch).toHaveBeenNthCalledWith(2, 7, 'top', [media('2')]);
    expect(deps.hashtags.setLastSynced).toHaveBeenCalledWith(7);
  });

  it('recent job uses recent_media edge and recent source', async () => {
    const deps = makeDeps([[media('1')]], []);
    await new SyncService(deps as unknown as SyncDeps).run(job(JOB_SYNC_RECENT));
    expect(deps.meta.fetchHashtagMedia).toHaveBeenCalledWith('h1', 'recent_media', 500);
    expect(deps.media.upsertBatch).toHaveBeenCalledWith(7, 'recent', [media('1')]);
  });

  it('uploads pending assets and records storage keys', async () => {
    const deps = makeDeps([], [{ id: 'm1', media_url: 'https://cdn/m1.jpg' }]);
    await new SyncService(deps as unknown as SyncDeps).run(job(JOB_SYNC_RECENT));
    expect(deps.storage.put).toHaveBeenCalledWith('media/m1.jpg', expect.any(Buffer), 'image/jpeg');
    expect(deps.media.setStorageKey).toHaveBeenCalledWith('m1', 'media/m1.jpg');
  });

  it('one failed asset does not fail the sync or block others', async () => {
    const deps = makeDeps([], [
      { id: 'bad', media_url: 'https://cdn/bad.jpg' },
      { id: 'good', media_url: 'https://cdn/good.jpg' },
    ]);
    deps.fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(Buffer.from('img'), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      ) as unknown as typeof fetch;
    const deps2 = { ...deps, assetConcurrency: 1 };
    await new SyncService(deps2 as unknown as SyncDeps).run(job(JOB_SYNC_RECENT));
    expect(deps.media.setStorageKey).toHaveBeenCalledTimes(1);
    expect(deps.media.setStorageKey).toHaveBeenCalledWith('good', 'media/good.jpg');
    expect(deps.hashtags.setLastSynced).toHaveBeenCalled();
  });

  it('throws on unknown hashtag', async () => {
    const deps = makeDeps([], []);
    deps.hashtags.findByName = vi.fn().mockResolvedValue(undefined);
    await expect(new SyncService(deps as unknown as SyncDeps).run(job(JOB_SYNC_RECENT))).rejects.toThrow(
      /unknown hashtag/,
    );
  });

  it('video content-type gets mp4 extension', async () => {
    const deps = makeDeps([], [{ id: 'v1', media_url: 'https://cdn/v1' }]);
    deps.fetchFn = vi.fn().mockResolvedValue(
      new Response(Buffer.from('vid'), { status: 200, headers: { 'content-type': 'video/mp4' } }),
    ) as unknown as typeof fetch;
    await new SyncService(deps as unknown as SyncDeps).run(job(JOB_SYNC_RECENT));
    expect(deps.media.setStorageKey).toHaveBeenCalledWith('v1', 'media/v1.mp4');
  });
});
