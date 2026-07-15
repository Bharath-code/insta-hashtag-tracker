import type { Job, JobHandler, JobPayload, Queue } from './index';

const MAX_ATTEMPTS = 3;

export class LocalQueue implements Queue {
  private readonly jobs: Array<{ job: Job; attempts: number }> = [];
  private handler?: JobHandler;
  private draining: Promise<void> = Promise.resolve();

  async enqueue(type: string, payload: JobPayload): Promise<void> {
    this.jobs.push({ job: { type, payload }, attempts: 0 });
    this.schedule();
  }

  start(handler: JobHandler): void {
    this.handler = handler;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.handler = undefined;
    await this.draining;
  }

  flush(): Promise<void> {
    return this.draining;
  }

  private schedule(): void {
    this.draining = this.draining.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    while (this.jobs.length > 0 && this.handler) {
      const entry = this.jobs.shift()!;
      try {
        await this.handler(entry.job);
      } catch (err) {
        entry.attempts += 1;
        if (entry.attempts < MAX_ATTEMPTS) {
          this.jobs.push(entry);
        } else {
          console.error(`job ${entry.job.type} dropped after ${MAX_ATTEMPTS} attempts`, err);
        }
      }
    }
  }
}
