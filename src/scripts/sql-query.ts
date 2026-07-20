/**
 * Safe SQL runner for one-off ECS tasks (private RDS).
 *
 * Usage:
 *   SQL_QUERY='SELECT count(*)::int AS n FROM media' node dist/scripts/sql-query.js
 *   node dist/scripts/sql-query.js --preset counts
 *   node dist/scripts/sql-query.js --preset recent --limit 5
 *
 * Safety defaults:
 *   - read-only statements only (SELECT / WITH / SHOW / EXPLAIN)
 *   - single statement
 *   - row cap (default 100)
 * Writes require SQL_ALLOW_WRITE=1 and --write
 */
import 'dotenv/config';
import { createDb } from '../db';

const PRESETS: Record<string, string> = {
  counts: `
    SELECT
      (SELECT count(*)::int FROM hashtags) AS hashtags,
      (SELECT count(*)::int FROM media) AS media,
      (SELECT count(*)::int FROM media WHERE storage_key IS NOT NULL) AS with_storage_key,
      (SELECT count(*)::int FROM media WHERE storage_key IS NULL) AS pending_storage
  `,
  hashtags: `
    SELECT id, name, meta_hashtag_id, last_synced_at, created_at
    FROM hashtags
    ORDER BY id
  `,
  recent: `
    SELECT id, media_type, source, like_count, comments_count,
           storage_key, posted_at
    FROM media
    ORDER BY posted_at DESC, id DESC
  `,
};

const READ_ONLY = /^(SELECT|WITH|SHOW|EXPLAIN)\b/i;
const WRITE_OK = /^(INSERT|UPDATE|DELETE|TRUNCATE)\b/i;

function parseArgs(argv: string[]): {
  sql: string | null;
  preset: string | null;
  limit: number;
  allowWrite: boolean;
} {
  let preset: string | null = null;
  let limit = 100;
  let allowWrite = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset' && argv[i + 1]) {
      preset = argv[++i];
    } else if (a === '--limit' && argv[i + 1]) {
      limit = Math.min(Math.max(Number(argv[++i]) || 100, 1), 500);
    } else if (a === '--write') {
      allowWrite = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      rest.push(a);
    }
  }

  const fromEnv = process.env.SQL_QUERY?.trim() || null;
  const sql = rest.length > 0 ? rest.join(' ').trim() : fromEnv;
  return { sql, preset, limit, allowWrite };
}

function printHelp(): void {
  console.log(`sql-query — run SQL against DATABASE_URL (ECS one-off safe defaults)

Presets: ${Object.keys(PRESETS).join(', ')}
Env:     SQL_QUERY, DATABASE_URL, SQL_ALLOW_WRITE=1 (with --write)

Examples:
  node dist/scripts/sql-query.js --preset counts
  SQL_QUERY='SELECT id FROM media LIMIT 5' node dist/scripts/sql-query.js
`);
}

function normalizeSql(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
}

function assertSafe(sql: string, allowWrite: boolean): void {
  const body = normalizeSql(sql);
  if (!body) throw new Error('empty SQL');

  // Single statement only (allow one trailing semicolon).
  const stripped = body.replace(/;\s*$/, '');
  if (stripped.includes(';')) {
    throw new Error('multiple statements are not allowed');
  }

  if (READ_ONLY.test(stripped)) return;

  if (allowWrite && process.env.SQL_ALLOW_WRITE === '1' && WRITE_OK.test(stripped)) {
    return;
  }

  throw new Error(
    'only read-only SQL is allowed by default (SELECT/WITH/SHOW/EXPLAIN). ' +
      'For writes, set SQL_ALLOW_WRITE=1 and pass --write',
  );
}

function applyLimit(sql: string, limit: number, isPresetRecent: boolean): string {
  const body = normalizeSql(sql).replace(/;\s*$/, '');
  // Preset recent always capped; other SELECTs without LIMIT get a safety cap.
  if (isPresetRecent) {
    return `${body} LIMIT ${limit}`;
  }
  if (/^SELECT\b/i.test(body) && !/\bLIMIT\b/i.test(body)) {
    return `${body} LIMIT ${limit}`;
  }
  return body;
}

async function main(): Promise<void> {
  const { sql: rawSql, preset, limit, allowWrite } = parseArgs(process.argv.slice(2));

  let sql: string;
  let isPresetRecent = false;
  if (preset) {
    const p = PRESETS[preset];
    if (!p) throw new Error(`unknown preset: ${preset} (try: ${Object.keys(PRESETS).join(', ')})`);
    sql = p;
    isPresetRecent = preset === 'recent';
  } else if (rawSql) {
    sql = rawSql;
  } else {
    printHelp();
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  assertSafe(sql, allowWrite);
  const finalSql = applyLimit(sql, limit, isPresetRecent);

  const db = createDb(databaseUrl);
  try {
    const result = await db.raw(finalSql);
    const rows = (result.rows ?? result) as unknown;
    // Markers so deploy/aws-sql.sh can extract JSON from CloudWatch logs.
    console.log('SQL_RESULT_BEGIN');
    console.log(
      JSON.stringify(
        {
          ok: true,
          rowCount: Array.isArray(rows) ? rows.length : null,
          rows,
        },
        null,
        2,
      ),
    );
    console.log('SQL_RESULT_END');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('SQL_RESULT_BEGIN');
  console.error(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  console.error('SQL_RESULT_END');
  process.exit(1);
});
