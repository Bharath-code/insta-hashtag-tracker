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
