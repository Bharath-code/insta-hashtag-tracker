import knex, { Knex } from 'knex';
import path from 'node:path';

// Local dev (tsx) loads .ts; Docker/prod (node dist/) loads compiled .js.
// Keep one runtime per database: use `npm run db:migrate` (tsx) locally,
// and `node dist/db/migrate.js` (or the migrate ECS task) on RDS.
const ext = __filename.endsWith('.js') ? 'js' : 'ts';

function connectionConfig(databaseUrl: string): string | Record<string, unknown> {
  // RDS requires TLS; local docker Postgres does not.
  const needsSsl =
    databaseUrl.includes('rds.amazonaws.com') ||
    /sslmode=/i.test(databaseUrl) ||
    process.env.PGSSLMODE === 'require';
  if (!needsSsl) return databaseUrl;
  // Strip sslmode from the URL so node-pg does not force verify-full and ignore our ssl options.
  const connectionString = databaseUrl
    .replace(/([?&])sslmode=[^&]*/gi, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
  return {
    connectionString,
    // Portfolio/demo: encrypt in transit without shipping the RDS CA bundle in the image.
    ssl: { rejectUnauthorized: false },
  };
}

export function createDb(databaseUrl: string): Knex {
  return knex({
    client: 'pg',
    connection: connectionConfig(databaseUrl),
    migrations: { directory: path.join(__dirname, 'migrations'), extension: ext },
    seeds: { directory: path.join(__dirname, 'seeds'), extension: ext },
  });
}
