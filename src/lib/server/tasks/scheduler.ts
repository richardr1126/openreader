import { runDueTasks } from './engine';
import { serverLogger } from '@/lib/server/logger';

const TICK_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 10_000;
export const VERCEL_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type TaskSchedulerInfo = {
  mode: 'self-hosted' | 'vercel-cron';
  tickIntervalMs: number;
  minimumIntervalMs: number;
};

export function getTaskSchedulerInfo(): TaskSchedulerInfo {
  if (process.env.VERCEL) {
    return {
      mode: 'vercel-cron',
      tickIntervalMs: VERCEL_TICK_INTERVAL_MS,
      minimumIntervalMs: VERCEL_TICK_INTERVAL_MS,
    };
  }
  return {
    mode: 'self-hosted',
    tickIntervalMs: TICK_INTERVAL_MS,
    minimumIntervalMs: TICK_INTERVAL_MS,
  };
}

let started = false;

/**
 * Start the in-process scheduler loop. Intended for the long-lived self-hosted
 * server only — on Vercel a cron route drives the ticks instead. Idempotent:
 * repeated calls (e.g. dev HMR) start a single loop.
 */
export function startTaskScheduler(): void {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      await runDueTasks();
    } catch (error) {
      serverLogger.warn(
        { event: 'tasks.scheduler.tick_failed', error: String(error) },
        'Task scheduler tick failed',
      );
    }
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  // Don't keep the process alive solely for the scheduler.
  if (typeof handle.unref === 'function') handle.unref();
}
