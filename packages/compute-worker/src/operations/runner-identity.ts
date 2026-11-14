import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { WorkerRunner } from './contracts';

/**
 * Which worker process is executing an operation.
 *
 * Heartbeat age can only ever guess at liveness: for as long as the window
 * lasts, an operation whose worker was killed still looks like work in
 * progress, and a reader watches a parse that will never report again. A worker
 * that has just started knows something better than a guess — it is running
 * nothing, so any operation its own previous incarnation left behind is
 * finished with, whatever its heartbeat says.
 *
 * `workerId` is the host, so it survives a restart and separates one deployed
 * worker from another. `incarnationId` is this process. The last-updated check
 * keeps the rule honest where a host runs two workers at once: a live sibling
 * keeps writing, so its operations are never older than this process's start.
 */
export interface RunnerIdentity extends WorkerRunner {
  startedAtMs: number;
}

export function createRunnerIdentity(startedAtMs = Date.now()): RunnerIdentity {
  return { workerId: hostname(), incarnationId: randomUUID(), startedAtMs };
}

/** This process replaced the worker that was running it, so nothing is now. */
export function outlivedItsRunner(input: {
  runner: WorkerRunner | undefined;
  updatedAt: number;
  identity: RunnerIdentity;
}): boolean {
  const { runner, updatedAt, identity } = input;
  if (!runner || runner.workerId !== identity.workerId) return false;
  if (runner.incarnationId === identity.incarnationId) return false;
  return updatedAt < identity.startedAtMs;
}

export const WORKER_RUNNER_IDENTITY = createRunnerIdentity();
