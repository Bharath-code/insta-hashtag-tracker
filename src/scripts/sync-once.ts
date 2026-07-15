import 'dotenv/config';
import { loadConfig } from '../config';
import { createDb } from '../db';
import { buildSyncContext } from '../bootstrap';
import { JOB_SYNC_RECENT } from '../services/sync';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL);
  const { sync, ensureHashtag } = buildSyncContext(cfg, db);
  const { hashtagId } = await ensureHashtag('matcha');
  await sync.run({ type: JOB_SYNC_RECENT, payload: { hashtag: 'matcha', hashtagId } });
  await db.destroy();
  console.log('sync complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
