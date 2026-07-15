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
