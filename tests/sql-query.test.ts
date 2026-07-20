import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const script = path.join(__dirname, '../src/scripts/sql-query.ts');

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    'npx',
    ['tsx', script, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env, DATABASE_URL: env.DATABASE_URL ?? 'postgres://x:y@localhost:5432/x' },
    },
  );
}

describe('sql-query safety', () => {
  it('rejects multiple statements', () => {
    const r = run([], { SQL_QUERY: 'SELECT 1; DROP TABLE media' });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/multiple statements/i);
  });

  it('rejects writes without flags', () => {
    const r = run([], { SQL_QUERY: 'DELETE FROM media' });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/read-only/i);
  });

  it('rejects unknown preset', () => {
    const r = run(['--preset', 'nope']);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/unknown preset/i);
  });
});
