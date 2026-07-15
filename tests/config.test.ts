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
