import 'dotenv/config';
import { loadConfig } from '../config';
import { createDb } from './index';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL);
  await db.migrate.latest();
  await db.seed.run();
  await db.destroy();
  console.log('migrations + seeds applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
