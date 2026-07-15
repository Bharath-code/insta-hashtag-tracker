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
