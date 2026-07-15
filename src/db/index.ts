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
