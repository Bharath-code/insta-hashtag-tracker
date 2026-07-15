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
