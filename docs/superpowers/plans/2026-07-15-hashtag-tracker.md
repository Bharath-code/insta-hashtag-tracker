# Instagram Hashtag Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingestion pipeline that syncs Instagram `matcha` hashtag media from the Meta Graph API into Postgres + S3/local storage, deduped, with a cursor-paginated `GET /hashtags` API.

**Architecture:** Two entry points (Express API, queue worker) over one TypeScript codebase. Worker consumes sync jobs from SQS (or an in-process LocalQueue), fetches paginated media from Meta, upserts per page (`ON CONFLICT (id)` dedupe), then uploads pending assets to storage. node-cron enqueues the recent sync every 3 hours. Spec: `docs/superpowers/specs/2026-07-15-hashtag-tracker-design.md`.

**Tech Stack:** Node 20+, TypeScript strict (CommonJS modules), Express, Knex + pg, zod, node-cron, @aws-sdk/client-s3, @aws-sdk/client-sqs, Vitest + supertest, ESLint + Prettier, tsx for running TS.

## Global Constraints

- TypeScript `strict: true`; no `any` in `src/`.
- TDD: every non-trivial unit gets its failing test first.
- Conventional commit messages (`feat:`, `test:`, `chore:`, `docs:`).
- Sync cap: 500 items per sync (`SYNC_MAX_ITEMS`), Meta page size 50 (`META_PAGE_SIZE`).
- Env vars validated at boot via zod; secrets only in `.env` (gitignored), documented in `.env.example`.
- Integration tests expect Postgres from `docker compose up -d` at `postgres://postgres:postgres@localhost:5432/hashtag`.
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Project scaffold and tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `.prettierrc`, `vitest.config.ts`, `docker-compose.yml`, `.gitignore`, `.env.example`

**Interfaces:**
- Consumes: nothing
- Produces: `npm run typecheck`, `npm test`, `npm run lint` all green; Postgres reachable via `docker compose up -d`.

- [ ] **Step 1: Init package and install dependencies**

```bash
npm init -y
npm pkg set type="commonjs" engines.node=">=20"
npm install express knex pg zod node-cron dotenv @aws-sdk/client-s3 @aws-sdk/client-sqs
npm install -D typescript tsx vitest supertest @types/express @types/node @types/supertest @types/node-cron eslint @eslint/js typescript-eslint prettier eslint-config-prettier
```

- [ ] **Step 2: Write config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    fileParallelism: false,
  },
});
```

`eslint.config.mjs`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  { ignores: ['dist/', 'node_modules/', 'storage/'] },
);
```

`.prettierrc`:
```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: hashtag
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

`.gitignore`:
```
node_modules/
dist/
storage/
.env
coverage/
```

`.env.example`:
```
# Postgres connection string
DATABASE_URL=postgres://postgres:postgres@localhost:5432/hashtag
# Meta Graph API
META_ACCESS_TOKEN=your-page-token
META_USER_ID=17841413741308252
META_API_BASE=https://graph.facebook.com/v24.0
# Drivers: local | sqs / local | s3
QUEUE_DRIVER=local
STORAGE_DRIVER=local
# Required when QUEUE_DRIVER=sqs
SQS_QUEUE_URL=
# Required when STORAGE_DRIVER=s3
S3_BUCKET=
AWS_REGION=
# Local storage directory (STORAGE_DRIVER=local)
STORAGE_LOCAL_DIR=./storage
PORT=3000
SYNC_MAX_ITEMS=500
META_PAGE_SIZE=50
```

- [ ] **Step 3: Add npm scripts**

```bash
npm pkg set scripts.typecheck="tsc --noEmit" scripts.test="vitest run" scripts.lint="eslint ." scripts.format="prettier --write ." scripts.dev:api="tsx watch src/api.ts" scripts.dev:worker="tsx watch src/worker.ts" scripts.db:migrate="tsx src/db/migrate.ts" scripts.sync:once="tsx src/scripts/sync-once.ts"
```

- [ ] **Step 4: Verify toolchain**

```bash
mkdir -p src tests && echo 'export {};' > src/placeholder.ts
npm run typecheck && npm test && npm run lint
docker compose up -d && docker compose ps
```
Expected: typecheck/test/lint all exit 0 (vitest passes with no tests); postgres container `running`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project with tooling and docker compose"
```

---

### Task 2: Config module (zod-validated env)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`
- Delete: `src/placeholder.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` — throws on missing/invalid vars. `Config` keys mirror env var names (`DATABASE_URL`, `META_ACCESS_TOKEN`, `META_USER_ID`, `META_API_BASE`, `QUEUE_DRIVER: 'local'|'sqs'`, `STORAGE_DRIVER: 'local'|'s3'`, `SQS_QUEUE_URL?`, `S3_BUCKET?`, `AWS_REGION?`, `STORAGE_LOCAL_DIR`, `PORT: number`, `SYNC_MAX_ITEMS: number`, `META_PAGE_SIZE: number`).

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const validEnv = {
  DATABASE_URL: 'postgres://x',
  META_ACCESS_TOKEN: 'token',
  META_USER_ID: '123',
};

describe('loadConfig', () => {
  it('loads valid env with defaults', () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.QUEUE_DRIVER).toBe('local');
    expect(cfg.STORAGE_DRIVER).toBe('local');
    expect(cfg.SYNC_MAX_ITEMS).toBe(500);
    expect(cfg.META_API_BASE).toBe('https://graph.facebook.com/v24.0');
    expect(cfg.PORT).toBe(3000);
  });

  it('throws naming missing vars', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('requires SQS_QUEUE_URL when QUEUE_DRIVER=sqs', () => {
    expect(() => loadConfig({ ...validEnv, QUEUE_DRIVER: 'sqs' })).toThrow(/SQS_QUEUE_URL/);
  });

  it('requires S3_BUCKET and AWS_REGION when STORAGE_DRIVER=s3', () => {
    expect(() => loadConfig({ ...validEnv, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config`.

- [ ] **Step 3: Write implementation**

`src/config.ts`:
```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  META_ACCESS_TOKEN: z.string().min(1),
  META_USER_ID: z.string().min(1),
  META_API_BASE: z.string().default('https://graph.facebook.com/v24.0'),
  QUEUE_DRIVER: z.enum(['local', 'sqs']).default('local'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  SQS_QUEUE_URL: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().optional(),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  PORT: z.coerce.number().int().positive().default(3000),
  SYNC_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  META_PAGE_SIZE: z.coerce.number().int().positive().default(50),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const bad = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment config: ${bad}`);
  }
  const cfg = parsed.data;
  if (cfg.QUEUE_DRIVER === 'sqs' && !cfg.SQS_QUEUE_URL) {
    throw new Error('SQS_QUEUE_URL is required when QUEUE_DRIVER=sqs');
  }
  if (cfg.STORAGE_DRIVER === 's3' && (!cfg.S3_BUCKET || !cfg.AWS_REGION)) {
    throw new Error('S3_BUCKET and AWS_REGION are required when STORAGE_DRIVER=s3');
  }
  return cfg;
}
```

- [ ] **Step 4: Run tests and cleanup placeholder**

```bash
rm src/placeholder.ts
npx vitest run tests/config.test.ts && npm run typecheck
```
Expected: 4 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: zod-validated env config with driver cross-checks"
```

---

### Task 3: Database — knex instance, migration, seed

**Files:**
- Create: `src/db/index.ts`, `src/db/migrations/20260715120000_init.ts`, `src/db/seeds/001_matcha.ts`, `src/db/migrate.ts`
- Test: `tests/db.test.ts`, `tests/helpers/db.ts`

**Interfaces:**
- Produces: `createDb(databaseUrl: string): Knex` (migrations + seeds directories preconfigured); tables `hashtags` and `media` per spec §4; test helper `getTestDb(): Knex` and `resetDb(db: Knex): Promise<void>`.

- [ ] **Step 1: Write the failing integration test**

`tests/helpers/db.ts`:
```ts
import type { Knex } from 'knex';
import { createDb } from '../../src/db';

export function getTestDb(): Knex {
  return createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hashtag');
}

export async function resetDb(db: Knex): Promise<void> {
  await db.migrate.latest();
  await db('media').del();
  await db('hashtags').del();
  await db.seed.run();
}
```

`tests/db.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — cannot find module `../../src/db`.

- [ ] **Step 3: Write knex factory, migration, seed**

`src/db/index.ts`:
```ts
import knex, { Knex } from 'knex';
import path from 'node:path';

export function createDb(databaseUrl: string): Knex {
  return knex({
    client: 'pg',
    connection: databaseUrl,
    migrations: { directory: path.join(__dirname, 'migrations'), extension: 'ts' },
    seeds: { directory: path.join(__dirname, 'seeds'), extension: 'ts' },
  });
}
```

`src/db/migrations/20260715120000_init.ts`:
```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('hashtags', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable().unique();
    t.text('meta_hashtag_id');
    t.timestamp('last_synced_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.schema.createTable('media', (t) => {
    t.text('id').primary();
    t.integer('hashtag_id').notNullable().references('hashtags.id');
    t.text('caption');
    t.text('media_type').notNullable();
    t.text('permalink').notNullable();
    t.text('media_url');
    t.text('storage_key');
    t.integer('like_count').notNullable().defaultTo(0);
    t.integer('comments_count').notNullable().defaultTo(0);
    t.timestamp('posted_at', { useTz: true }).notNullable();
    t.text('source').notNullable();
    t.timestamps(true, true);
    t.index(['posted_at', 'id'], 'media_feed_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('media');
  await knex.schema.dropTable('hashtags');
}
```

`src/db/seeds/001_matcha.ts`:
```ts
import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  await knex('hashtags').insert({ name: 'matcha' }).onConflict('name').ignore();
}
```

`src/db/migrate.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose up -d && npx vitest run tests/db.test.ts && npm run typecheck`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: knex setup, initial schema migration, matcha seed"
```

---

### Task 4: Cursor encode/decode

**Files:**
- Create: `src/services/cursor.ts`
- Test: `tests/cursor.test.ts`

**Interfaces:**
- Produces: `interface Cursor { p: string; i: string }` (`p` = posted_at ISO, `i` = media id); `encodeCursor(c: Cursor): string`; `decodeCursor(raw: string): Cursor | null` (null on any invalid input — never throws).

- [ ] **Step 1: Write the failing test**

`tests/cursor.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../src/services/cursor';

describe('cursor', () => {
  it('round-trips', () => {
    const c = { p: '2026-07-15T10:00:00.000Z', i: '18001234567' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('returns null for garbage input', () => {
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('returns null for valid base64 of wrong shape', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 1 })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null when p is not a date', () => {
    const bad = Buffer.from(JSON.stringify({ p: 'nope', i: '1' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cursor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/services/cursor.ts`:
```ts
export interface Cursor {
  p: string;
  i: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const obj: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof (obj as Cursor).p === 'string' &&
      typeof (obj as Cursor).i === 'string' &&
      !Number.isNaN(Date.parse((obj as Cursor).p))
    ) {
      return { p: (obj as Cursor).p, i: (obj as Cursor).i };
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cursor.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: opaque keyset cursor encode/decode"
```

---

### Task 5: Repositories — dedupe upsert and keyset page query

**Files:**
- Create: `src/services/media-repo.ts`
- Test: `tests/media-repo.test.ts`

**Interfaces:**
- Consumes: `createDb` (Task 3), `Cursor` (Task 4).
- Produces:
  - `interface MediaInput { id: string; media_type: string; permalink: string; timestamp: string; caption?: string; media_url?: string; like_count?: number; comments_count?: number }` (matches Meta API item shape from Task 6).
  - `interface MediaRow { id: string; hashtag_id: number; caption: string | null; media_type: string; permalink: string; media_url: string | null; storage_key: string | null; like_count: number; comments_count: number; posted_at: Date; source: string }`.
  - `class MediaRepo { constructor(db: Knex); upsertBatch(hashtagId: number, source: 'top' | 'recent', items: MediaInput[]): Promise<void>; listPage(limit: number, cursor?: Cursor): Promise<MediaRow[]>; findPendingAssets(hashtagId: number): Promise<Array<{ id: string; media_url: string }>>; setStorageKey(id: string, key: string): Promise<void> }`.
  - `interface HashtagRow { id: number; name: string; meta_hashtag_id: string | null; last_synced_at: Date | null }`.
  - `class HashtagRepo { constructor(db: Knex); findByName(name: string): Promise<HashtagRow | undefined>; setMetaId(id: number, metaHashtagId: string): Promise<void>; setLastSynced(id: number): Promise<void> }`.

- [ ] **Step 1: Write the failing integration test**

`tests/media-repo.test.ts`:
```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Knex } from 'knex';
import { getTestDb, resetDb } from './helpers/db';
import { MediaRepo, HashtagRepo, MediaInput } from '../src/services/media-repo';
import { encodeCursor, decodeCursor } from '../src/services/cursor';

function item(id: string, ts: string, likes = 1): MediaInput {
  return {
    id,
    media_type: 'IMAGE',
    permalink: `https://instagram.com/p/${id}`,
    timestamp: ts,
    media_url: `https://cdn.example.com/${id}.jpg`,
    like_count: likes,
    comments_count: 0,
  };
}

describe('MediaRepo', () => {
  let db: Knex;
  let repo: MediaRepo;
  let hashtagId: number;

  beforeAll(async () => {
    db = getTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
    repo = new MediaRepo(db);
    const row = await new HashtagRepo(db).findByName('matcha');
    hashtagId = row!.id;
  });
  afterAll(async () => db.destroy());

  it('upserting the same media twice yields one row with refreshed counts', async () => {
    await repo.upsertBatch(hashtagId, 'top', [item('m1', '2026-07-15T10:00:00Z', 5)]);
    await repo.upsertBatch(hashtagId, 'recent', [item('m1', '2026-07-15T10:00:00Z', 9)]);
    const rows = await db('media');
    expect(rows).toHaveLength(1);
    expect(rows[0].like_count).toBe(9);
    expect(rows[0].source).toBe('top');
  });

  it('lists newest-first and paginates with keyset cursor', async () => {
    await repo.upsertBatch(hashtagId, 'recent', [
      item('a', '2026-07-15T10:00:00Z'),
      item('b', '2026-07-15T11:00:00Z'),
      item('c', '2026-07-15T12:00:00Z'),
    ]);
    const page1 = await repo.listPage(2);
    expect(page1.map((r) => r.id)).toEqual(['c', 'b']);
    const cursor = decodeCursor(
      encodeCursor({ p: page1[1].posted_at.toISOString(), i: page1[1].id }),
    )!;
    const page2 = await repo.listPage(2, cursor);
    expect(page2.map((r) => r.id)).toEqual(['a']);
  });

  it('finds pending assets and clears them via setStorageKey', async () => {
    await repo.upsertBatch(hashtagId, 'recent', [item('m2', '2026-07-15T10:00:00Z')]);
    const pending = await repo.findPendingAssets(hashtagId);
    expect(pending).toEqual([{ id: 'm2', media_url: 'https://cdn.example.com/m2.jpg' }]);
    await repo.setStorageKey('m2', 'media/m2.jpg');
    expect(await repo.findPendingAssets(hashtagId)).toEqual([]);
  });

  it('handles empty batch without error', async () => {
    await expect(repo.upsertBatch(hashtagId, 'top', [])).resolves.toBeUndefined();
  });
});

describe('HashtagRepo', () => {
  let db: Knex;
  beforeAll(async () => {
    db = getTestDb();
    await resetDb(db);
  });
  afterAll(async () => db.destroy());

  it('sets meta id and last synced', async () => {
    const repo = new HashtagRepo(db);
    const row = (await repo.findByName('matcha'))!;
    await repo.setMetaId(row.id, '999');
    await repo.setLastSynced(row.id);
    const updated = (await repo.findByName('matcha'))!;
    expect(updated.meta_hashtag_id).toBe('999');
    expect(updated.last_synced_at).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/services/media-repo.ts`:
```ts
import type { Knex } from 'knex';
import type { Cursor } from './cursor';

export interface MediaInput {
  id: string;
  media_type: string;
  permalink: string;
  timestamp: string;
  caption?: string;
  media_url?: string;
  like_count?: number;
  comments_count?: number;
}

export interface MediaRow {
  id: string;
  hashtag_id: number;
  caption: string | null;
  media_type: string;
  permalink: string;
  media_url: string | null;
  storage_key: string | null;
  like_count: number;
  comments_count: number;
  posted_at: Date;
  source: string;
}

export interface HashtagRow {
  id: number;
  name: string;
  meta_hashtag_id: string | null;
  last_synced_at: Date | null;
}

export class MediaRepo {
  constructor(private readonly db: Knex) {}

  async upsertBatch(hashtagId: number, source: 'top' | 'recent', items: MediaInput[]): Promise<void> {
    if (items.length === 0) return;
    const rows = items.map((m) => ({
      id: m.id,
      hashtag_id: hashtagId,
      caption: m.caption ?? null,
      media_type: m.media_type,
      permalink: m.permalink,
      media_url: m.media_url ?? null,
      like_count: m.like_count ?? 0,
      comments_count: m.comments_count ?? 0,
      posted_at: m.timestamp,
      source,
      updated_at: this.db.fn.now(),
    }));
    await this.db('media')
      .insert(rows)
      .onConflict('id')
      .merge(['like_count', 'comments_count', 'updated_at']);
  }

  async listPage(limit: number, cursor?: Cursor): Promise<MediaRow[]> {
    let q = this.db<MediaRow>('media')
      .orderBy([
        { column: 'posted_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit);
    if (cursor) q = q.whereRaw('(posted_at, id) < (?, ?)', [cursor.p, cursor.i]);
    return q.select('*');
  }

  async findPendingAssets(hashtagId: number): Promise<Array<{ id: string; media_url: string }>> {
    return this.db('media')
      .where({ hashtag_id: hashtagId, storage_key: null })
      .whereNotNull('media_url')
      .select('id', 'media_url');
  }

  async setStorageKey(id: string, key: string): Promise<void> {
    await this.db('media').where({ id }).update({ storage_key: key, updated_at: this.db.fn.now() });
  }
}

export class HashtagRepo {
  constructor(private readonly db: Knex) {}

  findByName(name: string): Promise<HashtagRow | undefined> {
    return this.db<HashtagRow>('hashtags').where({ name }).first();
  }

  async setMetaId(id: number, metaHashtagId: string): Promise<void> {
    await this.db('hashtags')
      .where({ id })
      .update({ meta_hashtag_id: metaHashtagId, updated_at: this.db.fn.now() });
  }

  async setLastSynced(id: number): Promise<void> {
    await this.db('hashtags')
      .where({ id })
      .update({ last_synced_at: this.db.fn.now(), updated_at: this.db.fn.now() });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/media-repo.test.ts && npm run typecheck`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: media/hashtag repos with ON CONFLICT dedupe and keyset pagination"
```

---

### Task 6: Meta Graph API client

**Files:**
- Create: `src/meta/client.ts`
- Test: `tests/meta-client.test.ts`

**Interfaces:**
- Consumes: nothing internal (fetch injected for tests).
- Produces:
  - `type MetaMedia` — zod-inferred, structurally identical to `MediaInput` (Task 5).
  - `class MetaApiError extends Error { status: number }`.
  - `class MetaClient { constructor(opts: { accessToken: string; userId: string; baseUrl: string; pageSize?: number; fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void> }); searchHashtag(name: string): Promise<string>; fetchHashtagMedia(hashtagId: string, edge: 'top_media' | 'recent_media', maxItems: number): AsyncGenerator<MetaMedia[]> }`.

- [ ] **Step 1: Write the failing test**

`tests/meta-client.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { MetaClient, MetaApiError } from '../src/meta/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchFn: typeof fetch) {
  return new MetaClient({
    accessToken: 'tok',
    userId: 'u1',
    baseUrl: 'https://graph.test/v24.0',
    pageSize: 2,
    fetchFn,
    sleepFn: async () => {},
  });
}

const media = (id: string) => ({
  id,
  media_type: 'IMAGE',
  permalink: `https://ig/p/${id}`,
  timestamp: '2026-07-15T10:00:00+0000',
});

describe('MetaClient', () => {
  it('searchHashtag returns first hashtag id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'h123' }] }));
    const id = await makeClient(fetchFn as typeof fetch).searchHashtag('matcha');
    expect(id).toBe('h123');
    const url = new URL(fetchFn.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v24.0/ig_hashtag_search');
    expect(url.searchParams.get('q')).toBe('matcha');
  });

  it('paginates via after cursor and stops at maxItems', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [media('1'), media('2')],
          paging: { cursors: { after: 'A' }, next: 'https://next' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [media('3')],
          paging: { cursors: { after: 'B' }, next: 'https://next2' },
        }),
      );
    const pages: string[][] = [];
    for await (const page of makeClient(fetchFn as typeof fetch).fetchHashtagMedia('h1', 'recent_media', 3)) {
      pages.push(page.map((m) => m.id));
    }
    expect(pages).toEqual([['1', '2'], ['3']]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchFn.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get('after')).toBe('A');
    expect(secondUrl.searchParams.get('limit')).toBe('1');
  });

  it('stops when there is no next page', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [media('1')] }));
    const pages = [];
    for await (const p of makeClient(fetchFn as typeof fetch).fetchHashtagMedia('h1', 'top_media', 100)) {
      pages.push(p);
    }
    expect(pages).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries 500 then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'h1' }] }));
    await expect(makeClient(fetchFn as typeof fetch).searchHashtag('x')).resolves.toBe('h1');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry 400 and throws MetaApiError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('bad token', { status: 400 }));
    await expect(makeClient(fetchFn as typeof fetch).searchHashtag('x')).rejects.toThrow(MetaApiError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 attempts on persistent 500', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(makeClient(fetchFn as typeof fetch).searchHashtag('x')).rejects.toThrow(MetaApiError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/meta-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/meta/client.ts`:
```ts
import { z } from 'zod';

const mediaSchema = z.object({
  id: z.string(),
  media_type: z.string(),
  permalink: z.string(),
  timestamp: z.string(),
  caption: z.string().optional(),
  media_url: z.string().optional(),
  like_count: z.number().optional(),
  comments_count: z.number().optional(),
});

const pageSchema = z.object({
  data: z.array(mediaSchema),
  paging: z
    .object({
      cursors: z.object({ after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

const searchSchema = z.object({ data: z.array(z.object({ id: z.string() })).min(1) });

export type MetaMedia = z.infer<typeof mediaSchema>;

const FIELDS = 'id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count';
const MAX_ATTEMPTS = 3;

export class MetaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

export interface MetaClientOptions {
  accessToken: string;
  userId: string;
  baseUrl: string;
  pageSize?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

export class MetaClient {
  constructor(private readonly opts: MetaClientOptions) {}

  private async request(url: string): Promise<unknown> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const sleep = this.opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      const res = await fetchFn(url);
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new MetaApiError(res.status, `Meta API ${res.status}: ${await res.text()}`);
      }
      await sleep(500 * 2 ** (attempt - 1));
    }
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const u = new URL(`${this.opts.baseUrl}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('user_id', this.opts.userId);
    u.searchParams.set('access_token', this.opts.accessToken);
    return u.toString();
  }

  async searchHashtag(name: string): Promise<string> {
    const body = searchSchema.parse(await this.request(this.buildUrl('ig_hashtag_search', { q: name })));
    return body.data[0].id;
  }

  async *fetchHashtagMedia(
    hashtagId: string,
    edge: 'top_media' | 'recent_media',
    maxItems: number,
  ): AsyncGenerator<MetaMedia[]> {
    const pageSize = this.opts.pageSize ?? 50;
    let after: string | undefined;
    let fetched = 0;
    while (fetched < maxItems) {
      const params: Record<string, string> = {
        fields: FIELDS,
        limit: String(Math.min(pageSize, maxItems - fetched)),
      };
      if (after) params.after = after;
      const page = pageSchema.parse(await this.request(this.buildUrl(`${hashtagId}/${edge}`, params)));
      if (page.data.length === 0) return;
      yield page.data;
      fetched += page.data.length;
      after = page.paging?.cursors?.after;
      if (!after || !page.paging?.next) return;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/meta-client.test.ts && npm run typecheck`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Meta Graph API client with cursor pagination and backoff retry"
```

---

### Task 7: Storage — interface, LocalStorage, S3Storage, factory

**Files:**
- Create: `src/storage/index.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2).
- Produces: `interface Storage { put(key: string, body: Buffer, contentType?: string): Promise<void> }`; `class LocalStorage implements Storage { constructor(baseDir: string) }`; `class S3Storage implements Storage { constructor(bucket: string, region: string) }`; `createStorage(cfg: Config): Storage`.

- [ ] **Step 1: Write the failing test**

`tests/storage.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStorage, createStorage, S3Storage } from '../src/storage';
import { loadConfig } from '../src/config';

const baseEnv = { DATABASE_URL: 'postgres://x', META_ACCESS_TOKEN: 't', META_USER_ID: 'u' };

describe('LocalStorage', () => {
  it('writes body under baseDir, creating nested dirs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    await new LocalStorage(dir).put('media/abc.jpg', Buffer.from('hello'));
    const written = await fs.readFile(path.join(dir, 'media/abc.jpg'), 'utf8');
    expect(written).toBe('hello');
  });
});

describe('createStorage', () => {
  it('returns LocalStorage for local driver', () => {
    expect(createStorage(loadConfig(baseEnv))).toBeInstanceOf(LocalStorage);
  });

  it('returns S3Storage for s3 driver', () => {
    const cfg = loadConfig({ ...baseEnv, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', AWS_REGION: 'us-east-1' });
    expect(createStorage(cfg)).toBeInstanceOf(S3Storage);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/storage/index.ts`:
```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Config } from '../config';

export interface Storage {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
}

export class LocalStorage implements Storage {
  constructor(private readonly baseDir: string) {}

  async put(key: string, body: Buffer): Promise<void> {
    const filePath = path.join(this.baseDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
  }
}

export class S3Storage implements Storage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.client = new S3Client({ region });
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }
}

export function createStorage(cfg: Config): Storage {
  if (cfg.STORAGE_DRIVER === 's3') {
    // loadConfig guarantees these are set for the s3 driver
    return new S3Storage(cfg.S3_BUCKET as string, cfg.AWS_REGION as string);
  }
  return new LocalStorage(cfg.STORAGE_LOCAL_DIR);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/storage.test.ts && npm run typecheck`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: storage abstraction with local and S3 drivers"
```

---

### Task 8: Queue — interface, LocalQueue, SqsQueue, factory

**Files:**
- Create: `src/queue/index.ts`, `src/queue/local.ts`, `src/queue/sqs.ts`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2).
- Produces (in `src/queue/index.ts`):
  - `interface JobPayload { hashtag: string; hashtagId: string }`
  - `interface Job { type: string; payload: JobPayload }`
  - `type JobHandler = (job: Job) => Promise<void>`
  - `interface Queue { enqueue(type: string, payload: JobPayload): Promise<void>; start(handler: JobHandler): void; stop(): Promise<void> }`
  - `createQueue(cfg: Config): Queue`
- `LocalQueue` (in `local.ts`): in-memory FIFO, drains sequentially, retries a failed job up to 3 attempts, `flush(): Promise<void>` awaits drain (used by tests and sync-once script).

- [ ] **Step 1: Write the failing test**

`tests/queue.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/queue/index.ts`:
```ts
import type { Config } from '../config';
import { LocalQueue } from './local';
import { SqsQueue } from './sqs';

export interface JobPayload {
  hashtag: string;
  hashtagId: string;
}

export interface Job {
  type: string;
  payload: JobPayload;
}

export type JobHandler = (job: Job) => Promise<void>;

export interface Queue {
  enqueue(type: string, payload: JobPayload): Promise<void>;
  start(handler: JobHandler): void;
  stop(): Promise<void>;
}

export function createQueue(cfg: Config): Queue {
  if (cfg.QUEUE_DRIVER === 'sqs') {
    // loadConfig guarantees SQS_QUEUE_URL is set for the sqs driver
    return new SqsQueue(cfg.SQS_QUEUE_URL as string, cfg.AWS_REGION);
  }
  return new LocalQueue();
}
```

`src/queue/local.ts`:
```ts
import type { Job, JobHandler, JobPayload, Queue } from './index';

const MAX_ATTEMPTS = 3;

export class LocalQueue implements Queue {
  private readonly jobs: Array<{ job: Job; attempts: number }> = [];
  private handler?: JobHandler;
  private draining: Promise<void> = Promise.resolve();

  async enqueue(type: string, payload: JobPayload): Promise<void> {
    this.jobs.push({ job: { type, payload }, attempts: 0 });
    this.schedule();
  }

  start(handler: JobHandler): void {
    this.handler = handler;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.handler = undefined;
    await this.draining;
  }

  flush(): Promise<void> {
    return this.draining;
  }

  private schedule(): void {
    this.draining = this.draining.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    while (this.jobs.length > 0 && this.handler) {
      const entry = this.jobs.shift()!;
      try {
        await this.handler(entry.job);
      } catch (err) {
        entry.attempts += 1;
        if (entry.attempts < MAX_ATTEMPTS) {
          this.jobs.push(entry);
        } else {
          console.error(`job ${entry.job.type} dropped after ${MAX_ATTEMPTS} attempts`, err);
        }
      }
    }
  }
}
```

Note: `entry.attempts` counts *failures*; a job runs at most `MAX_ATTEMPTS` times (fails 3 times → dropped).

`src/queue/sqs.ts`:
```ts
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Job, JobHandler, JobPayload, Queue } from './index';

export class SqsQueue implements Queue {
  private readonly client: SQSClient;
  private running = false;

  constructor(
    private readonly queueUrl: string,
    region?: string,
  ) {
    this.client = new SQSClient(region ? { region } : {});
  }

  async enqueue(type: string, payload: JobPayload): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ type, payload }),
      }),
    );
  }

  start(handler: JobHandler): void {
    this.running = true;
    void this.poll(handler);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async poll(handler: JobHandler): Promise<void> {
    while (this.running) {
      try {
        const res = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 300,
          }),
        );
        for (const msg of res.Messages ?? []) {
          const job = JSON.parse(msg.Body ?? '{}') as Job;
          // On handler failure the message is NOT deleted; SQS visibility
          // timeout redelivers it — that is the retry mechanism.
          await handler(job);
          await this.client.send(
            new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: msg.ReceiptHandle }),
          );
        }
      } catch (err) {
        console.error('sqs poll/handle error', err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/queue.test.ts && npm run typecheck`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: queue abstraction with retrying LocalQueue and SQS driver"
```

---

### Task 9: Sync service

**Files:**
- Create: `src/services/sync.ts`
- Test: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `HashtagRepo`, `MediaRepo`, `MediaInput` (Task 5); `MetaClient`, `MetaMedia` (Task 6); `Storage` (Task 7); `Job` (Task 8).
- Produces:
  - `const JOB_SYNC_TOP = 'SYNC_TOP_HASHTAG_MEDIA'`, `const JOB_SYNC_RECENT = 'SYNC_RECENT_HASHTAG_MEDIA'`.
  - `interface SyncDeps { hashtags: Pick<HashtagRepo, 'findByName' | 'setLastSynced'>; media: Pick<MediaRepo, 'upsertBatch' | 'findPendingAssets' | 'setStorageKey'>; meta: Pick<MetaClient, 'fetchHashtagMedia'>; storage: Storage; maxItems: number; assetConcurrency?: number; fetchFn?: typeof fetch }`.
  - `class SyncService { constructor(deps: SyncDeps); run(job: Job): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

`tests/sync.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/services/sync.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync.test.ts && npm run typecheck`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: sync service — page-wise upsert and resumable asset uploads"
```

---

### Task 10: Express API — GET /hashtags

**Files:**
- Create: `src/app.ts` (Express app factory), `src/api.ts` (entry point)
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `MediaRepo` (Task 5), `encodeCursor`/`decodeCursor` (Task 4), `createDb` (Task 3), `loadConfig` (Task 2).
- Produces: `createApp(db: Knex): Express` — `GET /health` → `{ ok: true }`; `GET /hashtags?limit&cursor` → `{ data: MediaRow[], nextCursor: string | null }`, 400 on invalid cursor, limit clamped 1–100 (default 20), central JSON error handler.

- [ ] **Step 1: Write the failing test**

`tests/api.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Knex } from 'knex';
import { getTestDb, resetDb } from './helpers/db';
import { createApp } from '../src/app';
import { MediaRepo, HashtagRepo } from '../src/services/media-repo';

describe('GET /hashtags', () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = getTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
    app = createApp(db);
    const hashtag = (await new HashtagRepo(db).findByName('matcha'))!;
    const repo = new MediaRepo(db);
    await repo.upsertBatch(
      hashtag.id,
      'recent',
      ['a', 'b', 'c'].map((id, n) => ({
        id,
        media_type: 'IMAGE',
        permalink: `https://ig/p/${id}`,
        timestamp: `2026-07-15T1${n}:00:00Z`,
      })),
    );
  });
  afterAll(async () => db.destroy());

  it('returns newest first with a nextCursor that pages through', async () => {
    const page1 = await request(app).get('/hashtags?limit=2').expect(200);
    expect(page1.body.data.map((m: { id: string }) => m.id)).toEqual(['c', 'b']);
    expect(page1.body.nextCursor).toBeTypeOf('string');

    const page2 = await request(app)
      .get(`/hashtags?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .expect(200);
    expect(page2.body.data.map((m: { id: string }) => m.id)).toEqual(['a']);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('rejects invalid cursor with 400', async () => {
    const res = await request(app).get('/hashtags?cursor=garbage!').expect(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it('clamps limit to 100', async () => {
    await request(app).get('/hashtags?limit=5000').expect(200);
  });

  it('health endpoint responds', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/app.ts`:
```ts
import express, { Express, NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { MediaRepo } from './services/media-repo';
import { decodeCursor, encodeCursor } from './services/cursor';

export function createApp(db: Knex): Express {
  const app = express();
  const media = new MediaRepo(db);

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/hashtags', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);

      let cursor;
      if (req.query.cursor !== undefined) {
        cursor = decodeCursor(String(req.query.cursor));
        if (!cursor) {
          res.status(400).json({ error: 'invalid cursor' });
          return;
        }
      }

      const rows = await media.listPage(limit, cursor ?? undefined);
      const last = rows[rows.length - 1];
      const nextCursor =
        rows.length === limit && last
          ? encodeCursor({ p: new Date(last.posted_at).toISOString(), i: last.id })
          : null;
      res.json({ data: rows, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
```

`src/api.ts`:
```ts
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
```

Note: the error handler middleware must keep the unused `_next` parameter — Express identifies error handlers by arity (4 params). Add `// eslint-disable-next-line @typescript-eslint/no-unused-vars` above it if lint complains.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api.test.ts && npm run typecheck && npm run lint`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: express app with cursor-paginated GET /hashtags"
```

---

### Task 11: Worker entry point, cron, and sync-once script

**Files:**
- Create: `src/worker.ts`, `src/bootstrap.ts`, `src/scripts/sync-once.ts`
- Test: `tests/bootstrap.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9.
- Produces:
  - `buildSyncContext(cfg: Config, db: Knex): { queue: Queue; sync: SyncService; ensureHashtag(name: string): Promise<{ hashtag: HashtagRow; hashtagId: string }> }` in `src/bootstrap.ts` — shared wiring for worker and script. `ensureHashtag` resolves and caches `meta_hashtag_id` (calls `MetaClient.searchHashtag` only when the column is null).
  - `npm run dev:worker` starts consumer + cron `0 */3 * * *`; enqueues `JOB_SYNC_TOP` once when `last_synced_at` is null, and `JOB_SYNC_RECENT` at startup and on each cron tick.
  - `npm run sync:once` runs one recent sync directly (no queue) and exits.

- [ ] **Step 1: Write the failing test (hashtag-id caching logic)**

`tests/bootstrap.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bootstrap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write bootstrap, worker, and script**

`src/bootstrap.ts`:
```ts
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
```

`src/worker.ts`:
```ts
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
```

`src/scripts/sync-once.ts`:
```ts
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
```

- [ ] **Step 4: Run tests, then smoke-test end to end**

```bash
npx vitest run && npm run typecheck && npm run lint
```
Expected: full suite PASS.

Then the real smoke test (requires valid token in `.env` — copy `.env.example`, fill `META_ACCESS_TOKEN`):
```bash
npm run db:migrate
npm run sync:once
```
Expected: `sync complete`; `SELECT count(*) FROM media` > 0; files under `./storage/media/`. If Meta returns 4xx (expired assignment token), record the error output — the mocked test suite remains the correctness evidence, and note the token status in instructions.md.

Start the API and fetch a page:
```bash
npm run dev:api &
curl 'http://localhost:3000/hashtags?limit=5'
```
Expected: JSON `{ data: [...], nextCursor }` newest-first.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: worker with cron scheduling, shared bootstrap, sync-once script"
```

---

### Task 12: instructions.md, ai-usage, docs polish

**Files:**
- Create: `instructions.md`, `ai-usage/README.md`
- Modify: `docs/ENGINEERING.md` (update anything implementation contradicted)

**Interfaces:**
- Consumes: the finished system.
- Produces: assignment deliverables per problem_statement.md.

- [ ] **Step 1: Write instructions.md**

Must contain exactly these headers (assignment requirement): `setup`, `vars`, `tradeoffs`, `ai-usage`.

```markdown
# instructions

## setup

1. `docker compose up -d` — starts Postgres 16 on :5432
2. `cp .env.example .env` — fill `META_ACCESS_TOKEN` (and AWS vars if using sqs/s3 drivers)
3. `npm install`
4. `npm run db:migrate` — applies migrations and seeds the `matcha` hashtag
5. `npm run dev:worker` — starts the sync worker (syncs top media on first run, recent media every 3h)
6. `npm run dev:api` — starts the API on :3000
7. `curl 'http://localhost:3000/hashtags?limit=10'`

One-off sync without the worker: `npm run sync:once`
Tests: `npm test` (integration tests need the docker Postgres running)

## vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| DATABASE_URL | yes | — | Postgres connection string |
| META_ACCESS_TOKEN | yes | — | Instagram page token |
| META_USER_ID | yes | — | Instagram business account id |
| META_API_BASE | no | https://graph.facebook.com/v24.0 | Graph API base URL |
| QUEUE_DRIVER | no | local | `local` or `sqs` |
| SQS_QUEUE_URL | if sqs | — | SQS queue URL |
| STORAGE_DRIVER | no | local | `local` or `s3` |
| S3_BUCKET / AWS_REGION | if s3 | — | S3 target |
| STORAGE_LOCAL_DIR | no | ./storage | Local asset directory |
| PORT | no | 3000 | API port |
| SYNC_MAX_ITEMS | no | 500 | Per-sync media cap |
| META_PAGE_SIZE | no | 50 | Graph API page size |

AWS drivers use the standard AWS SDK credential chain (env vars / `~/.aws`).

## tradeoffs

See `docs/ENGINEERING.md` §10 for the full ledger. Highlights:
- node-cron in the worker instead of EventBridge — keeps the repo runnable with `npm run dev:worker`; the cron only calls `queue.enqueue()`, so EventBridge swaps in at one call site.
- No DLQ — failed jobs retry 3× (LocalQueue) or via SQS visibility timeout, then drop with a logged error.
- Carousel children flattened to one record; no owner fields (the hashtag API doesn't return them).
- Asset extension inferred from content-type (jpg/mp4) rather than parsing URLs.

## ai-usage

- **Tools:** Claude Code (Fable 5) end to end.
- **Used for:** brainstorming the design (spec in `docs/superpowers/specs/`), writing the implementation plan (`docs/superpowers/plans/`), generating code and tests task-by-task via TDD, drafting `docs/ENGINEERING.md`.
- **Reviewed/tested/written myself:** approved every design decision (AWS scope, Knex, cursor pagination, worker split); reviewed each task's diff before commit; ran the full test suite and the live smoke test (`npm run sync:once` + API pagination) against real Postgres.
- **Chat history:** exported in `ai-usage/`.
```

Adjust the ai-usage section to reflect what actually happened during the build.

- [ ] **Step 2: Create ai-usage folder**

`ai-usage/README.md`:
```markdown
# AI Usage — exported sessions

Claude Code session exports for this assignment. Sensitive values (tokens) redacted.

- `session-design-and-build.md` — brainstorming, spec, plan, implementation
```

Remind the user to export the session: in Claude Code run `/export` and save to `ai-usage/session-design-and-build.md`, then scrub the Meta token from the export (`sed -i '' 's/EAAM[A-Za-z0-9]*/<REDACTED_META_TOKEN>/g' ai-usage/*.md`).

- [ ] **Step 3: Reconcile docs/ENGINEERING.md with reality**

Read `docs/ENGINEERING.md` and fix anything the implementation changed (file names, retry counts, behavior). It is a living doc — it must match the shipped code.

- [ ] **Step 4: Final verification**

```bash
npm test && npm run typecheck && npm run lint
git grep -l "EAAM" -- ':!problem_statement.md' || echo "no leaked tokens"
```
Expected: suite green; no token leaked outside problem_statement.md (consider redacting it there too before pushing).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: instructions.md with setup/vars/tradeoffs/ai-usage, ai-usage folder"
```

---

## Post-plan notes

- **GitHub delivery:** after all tasks, create a repo and invite `saral-kalwani`, `pranav-getsaral`, `nivekithan-saral` (user action or `gh repo create` + `gh api` collaborator invites — confirm with user first).
- **Token caution:** the assignment token lives only in `.env` (gitignored) and `problem_statement.md`. Ask the user whether to redact `problem_statement.md` before pushing.
