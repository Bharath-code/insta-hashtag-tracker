import 'dotenv/config';
import { loadConfig } from './config';
import { createDb } from './db';
import { createApp } from './app';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
const app = createApp(db);

app.listen(cfg.PORT, () => {
  console.log(`api listening on :${cfg.PORT}`);
});
