import type { Consumer, JsMsg } from '@nats-io/jetstream';
import type {
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  PdfLayoutProgress,
  WhisperAlignJobRequest,
  WhisperAlignJobResult,
  WorkerJobTiming,
  WorkerOperationKind,
} from '../api/contracts';
import type { JsonCodec } from '../infrastructure/json-codec';
import type { JobHandlers } from './handlers';
import { buildQueueWaitTiming, decideRetryAction } from './worker-loop-policy';

const LOOP_ERROR_BACKOFF_MS = 500;
const RUNNING_HEARTBEAT_MS = 5000;
const PULL_EXPIRES_MS = 5_000;
const WHISPER_MAX_DELIVER = 1;
const SLOW_JOB_LOG_THRESHOLD_MS_BY_KIND: Record<WorkerOperationKind, number> = {
  whisper_align: 15_000,
  pdf_layout: 120_000,
};

export interface QueuedJob<TPayload> {
  jobId: string;
  opId: string;
  opKey: string;
  kind: WorkerOperationKind;
  queuedAt: number;
  payload: TPayload;
}

interface WorkerLoopOrchestrator {
  markRunning(input: { opId: string; startedAt?: number; updatedAt?: number; timing?: WorkerJobTiming }): Promise<unknown>;
  markProgress(input: {
    opId: string;
    progress: PdfLayoutProgress;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markSucceeded(input: { opId: string; result: unknown; updatedAt?: number; timing?: WorkerJobTiming }): Promise<unknown>;
  markFailed(input: {
    opId: string;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
}

interface WorkerLogger {
  info(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
}

class ConcurrencyGate {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.queue.shift()?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function safeDurationMs(start: number, end: number): number {
  return Math.max(0, Math.floor(end - start));
}

function extractTiming(result: unknown): WorkerJobTiming | undefined {
  if (!result || typeof result !== 'object' || !('timing' in result)) return undefined;
  return (result as { timing?: WorkerJobTiming }).timing;
}

function extractResultRef(kind: WorkerOperationKind, result: unknown): string | undefined {
  if (kind !== 'pdf_layout' || !result || typeof result !== 'object') return undefined;
  const maybe = result as { parsedObjectKey?: unknown };
  return typeof maybe.parsedObjectKey === 'string' ? maybe.parsedObjectKey : undefined;
}

export function createWorkerLoopController(input: {
  orchestrator: WorkerLoopOrchestrator;
  handlers: JobHandlers;
  logger: WorkerLogger;
  jobConcurrency: number;
  pdfAttempts: number;
  whisperCodec: JsonCodec<QueuedJob<WhisperAlignJobRequest>>;
  pdfCodec: JsonCodec<QueuedJob<PdfLayoutJobRequest>>;
  isOwnerActive: (owner: object) => boolean;
  isStopping: () => boolean;
  markActivity: (reason: string) => void;
  onInFlightJobsChanged: (delta: number) => void;
}) {
  const gate = new ConcurrencyGate(Math.max(1, Math.floor(input.jobConcurrency)));
  let loops: Promise<void>[] = [];
  let stopRequested = false;

  type Context<TPayload> = {
    decoded: QueuedJob<TPayload>;
    workerLabel: string;
    startedAt: number;
    queueWaitTiming?: { queueWaitMs: number };
    latestProgress?: PdfLayoutProgress;
  };

  const markRunning = async <TPayload>(context: Context<TPayload>, updatedAt: number): Promise<void> => {
    if (context.latestProgress) {
      await input.orchestrator.markProgress({
        opId: context.decoded.opId,
        progress: context.latestProgress,
        updatedAt,
        ...(context.queueWaitTiming ? { timing: context.queueWaitTiming } : {}),
      });
      return;
    }
    await input.orchestrator.markRunning({
      opId: context.decoded.opId,
      startedAt: context.startedAt,
      updatedAt,
      ...(context.queueWaitTiming ? { timing: context.queueWaitTiming } : {}),
    });
  };

  const processMessage = async <TPayload, TResult>(work: {
    msg: JsMsg;
    codec: JsonCodec<QueuedJob<TPayload>>;
    run: JobHandlers['runWhisper'] | JobHandlers['runPdfLayout'];
    workerLabel: string;
  }): Promise<void> => {
    let context: Context<TPayload> | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      const decoded = work.codec.decode(work.msg.data);
      const startedAt = Date.now();
      context = {
        decoded,
        workerLabel: work.workerLabel,
        startedAt,
        queueWaitTiming: buildQueueWaitTiming(decoded.queuedAt, startedAt),
      };
      await markRunning(context, startedAt);
      input.logger.info({
        worker: work.workerLabel,
        kind: decoded.kind,
        opId: decoded.opId,
        jobId: decoded.jobId,
        queueWaitMs: context.queueWaitTiming?.queueWaitMs ?? null,
        deliveryCount: work.msg.info.deliveryCount,
      }, 'job.started');
      heartbeat = setInterval(() => {
        void markRunning(context!, Date.now()).catch((error) => {
          input.logger.error({
            worker: work.workerLabel,
            opId: context?.decoded.opId,
            jobId: context?.decoded.jobId,
            error: toErrorMessage(error),
          }, 'failed to persist operation heartbeat state');
        });
      }, RUNNING_HEARTBEAT_MS);
      const result = await work.run(decoded.payload as never, context.queueWaitTiming?.queueWaitMs ?? 0, {
        onProgress: async (progress) => {
          try {
            work.msg.working();
          } catch (error) {
            input.logger.warn({
              worker: work.workerLabel,
              kind: context?.decoded.kind,
              opId: context?.decoded.opId,
              jobId: context?.decoded.jobId,
              error: toErrorMessage(error),
            }, 'failed to extend JetStream ack wait on progress');
          }
          context!.latestProgress = progress;
          await markRunning(context!, Date.now());
        },
      });
      const timing = extractTiming(result);
      const now = Date.now();
      await input.orchestrator.markSucceeded({
        opId: decoded.opId,
        result,
        updatedAt: now,
        ...(timing ? { timing } : {}),
      });
      work.msg.ack();
      const durationMs = safeDurationMs(startedAt, now);
      if (durationMs >= SLOW_JOB_LOG_THRESHOLD_MS_BY_KIND[decoded.kind]) {
        input.logger.info({ worker: work.workerLabel, kind: decoded.kind, opId: decoded.opId, jobId: decoded.jobId, durationMs, timing: timing ?? null }, 'job.stage');
      }
      input.logger.info({
        worker: work.workerLabel,
        kind: decoded.kind,
        opId: decoded.opId,
        jobId: decoded.jobId,
        status: 'succeeded',
        durationMs,
        resultRef: extractResultRef(decoded.kind, result),
        timing: timing ?? null,
      }, 'job.terminal');
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      const deliveryCount = work.msg.info.deliveryCount;
      const kind = context?.decoded.kind ?? 'pdf_layout';
      const action = decideRetryAction({ kind, deliveryCount, pdfAttempts: input.pdfAttempts, whisperMaxDeliver: WHISPER_MAX_DELIVER });
      const timing = context ? buildQueueWaitTiming(context.decoded.queuedAt, Date.now()) : undefined;
      if (context) {
        const update = action === 'nak_retry'
          ? markRunning(context, Date.now())
          : input.orchestrator.markFailed({
            opId: context.decoded.opId,
            error: { message: errorMessage },
            updatedAt: Date.now(),
            ...(timing ? { timing } : {}),
          });
        await update.catch((stateError) => input.logger.error({
          worker: context?.workerLabel,
          opId: context?.decoded.opId,
          jobId: context?.decoded.jobId,
          error: toErrorMessage(stateError),
        }, 'failed to persist operation state'));
      }
      if (action === 'nak_retry') work.msg.nak();
      else work.msg.term(errorMessage);
      input.logger.error({
        worker: context?.workerLabel,
        kind: context?.decoded.kind,
        opId: context?.decoded.opId,
        jobId: context?.decoded.jobId,
        status: action === 'nak_retry' ? 'running' : 'failed',
        error: errorMessage,
        deliveryCount,
        retryAction: action === 'nak_retry' ? 'nack_retry' : 'term',
      }, 'job.terminal');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  };

  const runLoop = async <TPayload>(work: {
    owner: object;
    consumer: Consumer;
    codec: JsonCodec<QueuedJob<TPayload>>;
    run: JobHandlers['runWhisper'] | JobHandlers['runPdfLayout'];
    workerLabel: string;
  }): Promise<void> => {
    const detached = () => input.isStopping() || stopRequested || !input.isOwnerActive(work.owner);
    while (!detached()) {
      let msg: JsMsg | null = null;
      try {
        try {
          msg = await work.consumer.next({ expires: PULL_EXPIRES_MS });
        } catch (error) {
          if (detached()) return;
          input.logger.error({ error: toErrorMessage(error), worker: work.workerLabel }, 'worker pull failed');
          await sleep(LOOP_ERROR_BACKOFF_MS);
          continue;
        }
        if (!msg) continue;
        input.markActivity(`job_received:${work.workerLabel}`);
        input.onInFlightJobsChanged(1);
        await gate.acquire();
        if (detached()) return;
        await processMessage({ ...work, msg });
      } finally {
        if (msg) {
          gate.release();
          input.onInFlightJobsChanged(-1);
          input.markActivity(`job_completed:${work.workerLabel}`);
        }
      }
    }
  };

  return {
    start(owner: object, consumers: { whisper: Consumer; pdfLayout: Consumer }): void {
      stopRequested = false;
      loops = [];
      for (let i = 0; i < input.jobConcurrency; i += 1) {
        loops.push(runLoop({ owner, consumer: consumers.whisper, codec: input.whisperCodec, run: input.handlers.runWhisper, workerLabel: `whisper-${i + 1}` }));
        loops.push(runLoop({ owner, consumer: consumers.pdfLayout, codec: input.pdfCodec, run: input.handlers.runPdfLayout, workerLabel: `layout-${i + 1}` }));
      }
    },
    async stop(): Promise<void> {
      stopRequested = true;
      await Promise.allSettled(loops);
      loops = [];
    },
  };
}
