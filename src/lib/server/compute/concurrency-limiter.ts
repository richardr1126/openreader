import { getComputeJobConcurrency } from '@openreader/compute-core';

export class ConcurrencyLimiter {
  private readonly maxInFlight: number;
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.maxInFlight = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export const LOCAL_COMPUTE_LIMITER = new ConcurrencyLimiter(getComputeJobConcurrency());
