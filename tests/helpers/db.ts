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
