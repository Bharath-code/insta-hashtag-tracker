import 'dotenv/config';
import cron from 'node-cron';
import { loadConfig } from './config';
import { createDb } from './db';
import { buildSyncContext } from './bootstrap';
import { JOB_SYNC_TOP, JOB_SYNC_RECENT } from './services/sync';

const TRACKED_HASHTAG = 'matcha';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL);
  const { queue, sync, ensureHashtag } = buildSyncContext(cfg, db);

  const { hashtag, hashtagId } = await ensureHashtag(TRACKED_HASHTAG);
  const payload = { hashtag: TRACKED_HASHTAG, hashtagId };

  queue.start((job) => sync.run(job));

  if (!hashtag.last_synced_at) {
    await queue.enqueue(JOB_SYNC_TOP, payload);
  }
  await queue.enqueue(JOB_SYNC_RECENT, payload);

  cron.schedule('0 */3 * * *', () => {
    void queue.enqueue(JOB_SYNC_RECENT, payload);
  });

  console.log(`worker started (queue=${cfg.QUEUE_DRIVER}, storage=${cfg.STORAGE_DRIVER})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
