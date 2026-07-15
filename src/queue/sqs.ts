import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Job, JobHandler, JobPayload, Queue } from './index';

export class SqsQueue implements Queue {
  private readonly client: SQSClient;
  private running = false;

  constructor(
    private readonly queueUrl: string,
    region?: string,
  ) {
    this.client = new SQSClient(region ? { region } : {});
  }

  async enqueue(type: string, payload: JobPayload): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ type, payload }),
      }),
    );
  }

  start(handler: JobHandler): void {
    this.running = true;
    void this.poll(handler);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async poll(handler: JobHandler): Promise<void> {
    while (this.running) {
      try {
        const res = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 300,
          }),
        );
        for (const msg of res.Messages ?? []) {
          const job = JSON.parse(msg.Body ?? '{}') as Job;
          // On handler failure the message is NOT deleted; SQS visibility
          // timeout redelivers it — that is the retry mechanism.
          await handler(job);
          await this.client.send(
            new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: msg.ReceiptHandle }),
          );
        }
      } catch (err) {
        console.error('sqs poll/handle error', err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
