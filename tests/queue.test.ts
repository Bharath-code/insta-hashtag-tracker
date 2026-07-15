import { describe, it, expect, vi } from 'vitest';
import { LocalQueue } from '../src/queue/local';
import { createQueue } from '../src/queue';
import { loadConfig } from '../src/config';
import type { Job } from '../src/queue';

const payload = { hashtag: 'matcha', hashtagId: 'h1' };

describe('LocalQueue', () => {
  it('delivers enqueued jobs to the handler in order', async () => {
    const q = new LocalQueue();
    const seen: string[] = [];
    q.start(async (job: Job) => {
      seen.push(job.type);
    });
    await q.enqueue('A', payload);
    await q.enqueue('B', payload);
    await q.flush();
    expect(seen).toEqual(['A', 'B']);
  });

  it('retries a failing job up to 3 attempts then drops it', async () => {
    const q = new LocalQueue();
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    q.start(handler);
    await q.enqueue('A', payload);
    await q.flush();
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('processes jobs enqueued before start', async () => {
    const q = new LocalQueue();
    await q.enqueue('A', payload);
    const handler = vi.fn().mockResolvedValue(undefined);
    q.start(handler);
    await q.flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('createQueue', () => {
  it('returns LocalQueue for local driver', () => {
    const cfg = loadConfig({ DATABASE_URL: 'p', META_ACCESS_TOKEN: 't', META_USER_ID: 'u' });
    expect(createQueue(cfg)).toBeInstanceOf(LocalQueue);
  });
});
