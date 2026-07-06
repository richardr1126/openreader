import type { Consumer, JsMsg } from '@nats-io/jetstream';
import type {
  DocumentPreviewJobRequest,
  DocumentPreviewJobResult,
  DocumentConversionJobRequest,
  DocumentConversionJobResult,
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  TtsPlaybackPlanJobRequest,
  TtsPlaybackPlanJobResult,
  TtsPlaybackExportArtifactRequest,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackJobRequest,
  TtsPlaybackJobResult,
  WorkerJobTiming,
  WorkerOperationKind,
  WorkerOperationProgress,
} from '../operations/contracts';
import type { JsonCodec } from '../infrastructure/json-codec';
import type { JobHandlers } from './handlers';
import { buildQueueWaitTiming, decideRetryAction } from './worker-loop-policy';

const LOOP_ERROR_BACKOFF_MS = 500;
const RUNNING_HEARTBEAT_MS = 5000;
const PULL_EXPIRES_MS = 5_000;
const SLOW_JOB_LOG_THRESHOLD_MS_BY_KIND: Record<WorkerOperationKind, number> = {
  pdf_layout: 120_000,
  tts_playback: 30_000,
  tts_playback_plan: 30_000,
  tts_playback_export: 120_000,
  document_preview: 120_000,
  document_conversion: 120_000,
};

export interface QueuedJob<TPayload> {
  jobId: string;
  opId: string;
  opKey: string;
  kind: WorkerOperationKind;
  queuedAt: number;
  payload: TPayload;
}

export interface WorkerLoopOrchestrator {
  markRunning(input: { opId: string; startedAt?: number; updatedAt?: number; timing?: WorkerJobTiming }): Promise<unknown>;
  markProgress(input: {
    opId: string;
    progress: WorkerOperationProgress;
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

export interface WorkerLogger {
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

function toErrorLog(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || String(error),
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
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
  pdfCodec: JsonCodec<QueuedJob<PdfLayoutJobRequest>>;
  ttsPlaybackCodec?: JsonCodec<QueuedJob<TtsPlaybackJobRequest>>;
  ttsPlaybackPlanCodec?: JsonCodec<QueuedJob<TtsPlaybackPlanJobRequest>>;
  ttsPlaybackExportCodec?: JsonCodec<QueuedJob<TtsPlaybackExportArtifactRequest>>;
  documentPreviewCodec?: JsonCodec<QueuedJob<DocumentPreviewJobRequest>>;
  documentConversionCodec?: JsonCodec<QueuedJob<DocumentConversionJobRequest>>;
  isOwnerActive: (owner: object) => boolean;
  isStopping: () => boolean;
  markActivity: (reason: string) => void;
  onInFlightJobsChanged: (delta: number) => void;
}) {
  const playbackGate = new ConcurrencyGate(Math.max(1, Math.floor(input.jobConcurrency)));
  const planGate = new ConcurrencyGate(Math.max(1, Math.floor(input.jobConcurrency)));
  const layoutGate = new ConcurrencyGate(Math.max(1, Math.floor(input.jobConcurrency)));
  let loops: Promise<void>[] = [];
  let stopRequested = false;

  type Context<TPayload> = {
    decoded: QueuedJob<TPayload>;
    workerLabel: string;
    startedAt: number;
    queueWaitTiming?: { queueWaitMs: number };
    latestProgress?: WorkerOperationProgress;
  };

  type JobRunner<TPayload, TResult> = (
    payload: TPayload,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: WorkerOperationProgress) => Promise<void> },
  ) => Promise<TResult>;

  type WorkDefinition<TPayload, TResult> = {
    codec: JsonCodec<QueuedJob<TPayload>>;
    run: JobRunner<TPayload, TResult>;
    gate: ConcurrencyGate;
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

  const processMessage = async <TPayload, TResult>(work: WorkDefinition<TPayload, TResult> & {
    msg: JsMsg;
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
      const result = await work.run(decoded.payload, context.queueWaitTiming?.queueWaitMs ?? 0, {
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
      const errorLog = toErrorLog(error);
      const deliveryCount = work.msg.info.deliveryCount;
      const kind = context?.decoded.kind ?? 'pdf_layout';
      const action = decideRetryAction({ kind, deliveryCount, pdfAttempts: input.pdfAttempts });
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
        errorName: errorLog.name,
        errorStack: errorLog.stack,
        deliveryCount,
        retryAction: action === 'nak_retry' ? 'nack_retry' : 'term',
      }, 'job.terminal');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  };

  const runLoop = async <TPayload, TResult>(work: WorkDefinition<TPayload, TResult> & {
    owner: object;
    consumer: Consumer;
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
        await work.gate.acquire();
        if (detached()) return;
        await processMessage({ ...work, msg });
      } finally {
        if (msg) {
          work.gate.release();
          input.onInFlightJobsChanged(-1);
          input.markActivity(`job_completed:${work.workerLabel}`);
        }
      }
    }
  };

  return {
    start(owner: object, consumers: {
      pdfLayout: Consumer;
      ttsPlayback?: Consumer;
      ttsPlaybackPlan?: Consumer;
      ttsPlaybackExport?: Consumer;
      documentPreview?: Consumer;
      documentConversion?: Consumer;
    }): void {
      stopRequested = false;
      loops = [];
      const pdfWork: WorkDefinition<PdfLayoutJobRequest, PdfLayoutJobResult> = {
        codec: input.pdfCodec,
        run: input.handlers.runPdfLayout,
        gate: layoutGate,
      };
      const ttsPlaybackWork: WorkDefinition<TtsPlaybackJobRequest, TtsPlaybackJobResult> | null =
        input.ttsPlaybackCodec && consumers.ttsPlayback
          ? {
            codec: input.ttsPlaybackCodec,
            run: input.handlers.runTtsPlayback,
            gate: playbackGate,
          }
          : null;
      const ttsPlaybackPlanWork: WorkDefinition<TtsPlaybackPlanJobRequest, TtsPlaybackPlanJobResult> | null =
        input.ttsPlaybackPlanCodec && consumers.ttsPlaybackPlan
          ? {
            codec: input.ttsPlaybackPlanCodec,
            run: input.handlers.runTtsPlaybackPlan,
            gate: planGate,
          }
          : null;
      const ttsPlaybackExportWork: WorkDefinition<TtsPlaybackExportArtifactRequest, TtsPlaybackExportArtifactResult> | null =
        input.ttsPlaybackExportCodec && consumers.ttsPlaybackExport
          ? {
            codec: input.ttsPlaybackExportCodec,
            run: input.handlers.runTtsPlaybackExportArtifact,
            gate: playbackGate,
          }
          : null;
      const documentPreviewWork: WorkDefinition<DocumentPreviewJobRequest, DocumentPreviewJobResult> | null =
        input.documentPreviewCodec && consumers.documentPreview
          ? {
            codec: input.documentPreviewCodec,
            run: input.handlers.runDocumentPreview,
            gate: layoutGate,
          }
          : null;
      const documentConversionWork: WorkDefinition<DocumentConversionJobRequest, DocumentConversionJobResult> | null =
        input.documentConversionCodec && consumers.documentConversion
          ? {
            codec: input.documentConversionCodec,
            run: input.handlers.runDocumentConversion,
            gate: layoutGate,
          }
          : null;
      for (let i = 0; i < input.jobConcurrency; i += 1) {
        loops.push(runLoop({ owner, consumer: consumers.pdfLayout, ...pdfWork, workerLabel: `layout-${i + 1}` }));
        if (ttsPlaybackWork && consumers.ttsPlayback) {
          loops.push(runLoop({ owner, consumer: consumers.ttsPlayback, ...ttsPlaybackWork, workerLabel: `tts-playback-${i + 1}` }));
        }
        if (ttsPlaybackPlanWork && consumers.ttsPlaybackPlan) {
          loops.push(runLoop({ owner, consumer: consumers.ttsPlaybackPlan, ...ttsPlaybackPlanWork, workerLabel: `tts-playback-plan-${i + 1}` }));
        }
        if (ttsPlaybackExportWork && consumers.ttsPlaybackExport) {
          loops.push(runLoop({ owner, consumer: consumers.ttsPlaybackExport, ...ttsPlaybackExportWork, workerLabel: `tts-playback-export-${i + 1}` }));
        }
        if (documentPreviewWork && consumers.documentPreview) {
          loops.push(runLoop({ owner, consumer: consumers.documentPreview, ...documentPreviewWork, workerLabel: `document-preview-${i + 1}` }));
        }
        if (documentConversionWork && consumers.documentConversion) {
          loops.push(runLoop({ owner, consumer: consumers.documentConversion, ...documentConversionWork, workerLabel: `document-conversion-${i + 1}` }));
        }
      }
    },
    async stop(): Promise<void> {
      stopRequested = true;
      await Promise.allSettled(loops);
      loops = [];
    },
  };
}
