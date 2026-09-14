import type { Consumer, JsMsg } from '@nats-io/jetstream';
import type {
  AccountExportJobRequest,
  AccountExportJobResult,
  EmailDeliveryJobRequest,
  EmailDeliveryJobResult,
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
import { WORKER_OPERATION_KIND_POLICY } from '../operations/contracts';
import type { JsonCodec } from '../infrastructure/json-codec';
import type { JobHandlers } from './handlers';
import { buildQueueWaitTiming, decideRetryAction } from './worker-loop-policy';
import { toErrorMessage } from '../infrastructure/errors';
import { TtsCredentialBrokerClientError } from './tts-credential-broker-error';
import { EmailDeliveryError } from './email-delivery';
import {
  type ComputeLimitPolicyDocument,
  type WorkerOperationAction,
} from '@openreader/runtime-config/compute-limits';
import {
  ComputeExecutionScheduler,
  type ComputeExecutionLease,
} from './execution-scheduler';

const LOOP_ERROR_BACKOFF_MS = 500;
const RUNNING_HEARTBEAT_MS = 5000;
const PULL_EXPIRES_MS = 5_000;

class ComputeQueueExpiredError extends Error {
  readonly code = 'COMPUTE_QUEUE_AGE_EXCEEDED';

  constructor() {
    super('Compute work expired before execution capacity became available');
    this.name = 'ComputeQueueExpiredError';
  }
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  getComputePolicy: () => ComputeLimitPolicyDocument;
  pdfAttempts: number;
  pdfCodec: JsonCodec<QueuedJob<PdfLayoutJobRequest>>;
  ttsPlaybackCodec?: JsonCodec<QueuedJob<TtsPlaybackJobRequest>>;
  ttsPlaybackPlanCodec?: JsonCodec<QueuedJob<TtsPlaybackPlanJobRequest>>;
  ttsPlaybackExportCodec?: JsonCodec<QueuedJob<TtsPlaybackExportArtifactRequest>>;
  documentPreviewCodec?: JsonCodec<QueuedJob<DocumentPreviewJobRequest>>;
  documentConversionCodec?: JsonCodec<QueuedJob<DocumentConversionJobRequest>>;
  accountExportCodec?: JsonCodec<QueuedJob<AccountExportJobRequest>>;
  emailDeliveryCodec?: JsonCodec<QueuedJob<EmailDeliveryJobRequest>>;
  isOwnerActive: (owner: object) => boolean;
  isStopping: () => boolean;
  markActivity: (reason: string) => void;
  onInFlightJobsChanged: (delta: number) => void;
  onOperationTerminal?: (input: {
    operationId: string;
    state: 'succeeded' | 'failed' | 'cancelled';
  }) => Promise<void>;
}) {
  const scheduler = new ComputeExecutionScheduler(input.getComputePolicy);
  let loops: Promise<void>[] = [];
  let stopRequested = false;
  let growLoops: (() => void) | null = null;

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
    action?: WorkerOperationAction;
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
    queueExpired?: boolean;
  }): Promise<void> => {
    let context: Context<TPayload> | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      const decoded = work.codec.decode(work.msg.data);
      const startedAt = Date.now();
      const maxQueueAgeMs = work.action
        ? input.getComputePolicy().actions[work.action].execution!.maxQueueAgeSeconds * 1000
        : Math.max(1, decoded.payload && typeof decoded.payload === 'object' && 'expiresAt' in decoded.payload
          ? Number((decoded.payload as { expiresAt: number }).expiresAt) - decoded.queuedAt
          : 60 * 60 * 1000);
      context = {
        decoded,
        workerLabel: work.workerLabel,
        startedAt,
        queueWaitTiming: buildQueueWaitTiming(decoded.queuedAt, startedAt),
      };
      if (work.queueExpired || startedAt - decoded.queuedAt > maxQueueAgeMs) {
        throw new ComputeQueueExpiredError();
      }
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
      await input.onOperationTerminal?.({ operationId: decoded.opId, state: 'succeeded' })
        .catch((error) => input.logger.warn({
          opId: decoded.opId,
          error: toErrorMessage(error),
        }, 'compute admission completion callback failed'));
      work.msg.ack();
      const durationMs = safeDurationMs(startedAt, now);
      if (durationMs >= WORKER_OPERATION_KIND_POLICY[decoded.kind].slowJobLogThresholdMs) {
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
      const action = error instanceof ComputeQueueExpiredError
        ? 'term'
        : decideRetryAction({
          kind,
          deliveryCount,
          pdfAttempts: input.pdfAttempts,
          retryable: error instanceof TtsCredentialBrokerClientError || error instanceof EmailDeliveryError
            ? error.retryable
            : undefined,
        });
      const timing = context ? buildQueueWaitTiming(context.decoded.queuedAt, Date.now()) : undefined;
      if (context) {
        const update = action === 'nak_retry'
          ? markRunning(context, Date.now())
          : input.orchestrator.markFailed({
            opId: context.decoded.opId,
            error: {
              message: errorMessage,
              ...(error instanceof ComputeQueueExpiredError ? { code: error.code } : {}),
            },
            updatedAt: Date.now(),
            ...(timing ? { timing } : {}),
          });
        await update.catch((stateError) => input.logger.error({
          worker: context?.workerLabel,
          opId: context?.decoded.opId,
          jobId: context?.decoded.jobId,
          error: toErrorMessage(stateError),
        }, 'failed to persist operation state'));
        if (action !== 'nak_retry') {
          await input.onOperationTerminal?.({
            operationId: context.decoded.opId,
            state: 'failed',
          }).catch((callbackError) => input.logger.warn({
            opId: context?.decoded.opId,
            error: toErrorMessage(callbackError),
          }, 'compute admission completion callback failed'));
        }
      }
      if (action === 'nak_retry') {
        const retryDelayMs = error instanceof EmailDeliveryError
          ? error.retryAfterMs ?? Math.min(10_000, 500 * (2 ** Math.max(0, deliveryCount - 1)))
          : undefined;
        work.msg.nak(retryDelayMs);
      }
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
      let executionLease: ComputeExecutionLease | null = null;
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
        const queueHeartbeat = setInterval(() => {
          try {
            msg?.working();
          } catch {
            // A detached or redelivered message is handled by the normal loop path.
          }
        }, RUNNING_HEARTBEAT_MS);
        try {
          if (work.action) {
            const acquisition = await scheduler.acquire(work.action);
            if (acquisition.status === 'acquired') executionLease = acquisition.lease;
            else if (acquisition.status === 'expired') {
              await processMessage({ ...work, msg, queueExpired: true });
              continue;
            }
          }
        } finally {
          clearInterval(queueHeartbeat);
        }
        if (work.action && !executionLease) {
          msg.nak();
          continue;
        }
        if (detached()) {
          msg.nak();
          return;
        }
        await processMessage({ ...work, msg });
      } finally {
        if (msg) {
          if (executionLease) scheduler.release(executionLease);
          input.onInFlightJobsChanged(-1);
          input.markActivity(`job_completed:${work.workerLabel}`);
        }
      }
    }
  };

  return {
    policyChanged(): void {
      scheduler.policyChanged();
      growLoops?.();
    },
    start(owner: object, consumers: {
      pdfLayout: Consumer;
      ttsPlayback?: Consumer;
      ttsPlaybackPlan?: Consumer;
      ttsPlaybackExport?: Consumer;
      documentPreview?: Consumer;
      documentConversion?: Consumer;
      accountExport?: Consumer;
      emailDelivery?: Consumer;
    }): void {
      stopRequested = false;
      loops = [];
      const pdfWork: WorkDefinition<PdfLayoutJobRequest, PdfLayoutJobResult> = {
        codec: input.pdfCodec,
        run: input.handlers.runPdfLayout,
        action: 'pdf_layout',
      };
      const ttsPlaybackWork: WorkDefinition<TtsPlaybackJobRequest, TtsPlaybackJobResult> | null =
        input.ttsPlaybackCodec && consumers.ttsPlayback
          ? {
            codec: input.ttsPlaybackCodec,
            run: input.handlers.runTtsPlayback,
            action: 'tts_playback',
          }
          : null;
      const ttsPlaybackPlanWork: WorkDefinition<TtsPlaybackPlanJobRequest, TtsPlaybackPlanJobResult> | null =
        input.ttsPlaybackPlanCodec && consumers.ttsPlaybackPlan
          ? {
            codec: input.ttsPlaybackPlanCodec,
            run: input.handlers.runTtsPlaybackPlan,
            action: 'tts_playback_plan',
          }
          : null;
      const ttsPlaybackExportWork: WorkDefinition<TtsPlaybackExportArtifactRequest, TtsPlaybackExportArtifactResult> | null =
        input.ttsPlaybackExportCodec && consumers.ttsPlaybackExport
          ? {
            codec: input.ttsPlaybackExportCodec,
            run: input.handlers.runTtsPlaybackExportArtifact,
            action: 'tts_playback_export',
          }
          : null;
      const documentPreviewWork: WorkDefinition<DocumentPreviewJobRequest, DocumentPreviewJobResult> | null =
        input.documentPreviewCodec && consumers.documentPreview
          ? {
            codec: input.documentPreviewCodec,
            run: input.handlers.runDocumentPreview,
            action: 'document_preview',
          }
          : null;
      const documentConversionWork: WorkDefinition<DocumentConversionJobRequest, DocumentConversionJobResult> | null =
        input.documentConversionCodec && consumers.documentConversion
          ? {
            codec: input.documentConversionCodec,
            run: input.handlers.runDocumentConversion,
            action: 'document_conversion',
          }
          : null;
      const accountExportWork: WorkDefinition<AccountExportJobRequest, AccountExportJobResult> | null =
        input.accountExportCodec && consumers.accountExport
          ? {
            codec: input.accountExportCodec,
            run: input.handlers.runAccountExport,
            action: 'account_export',
          }
          : null;
      const emailDeliveryWork: WorkDefinition<EmailDeliveryJobRequest, EmailDeliveryJobResult> | null =
        input.emailDeliveryCodec && consumers.emailDelivery && input.handlers.runEmailDelivery
          ? { codec: input.emailDeliveryCodec, run: input.handlers.runEmailDelivery }
          : null;
      let loopSlots = 0;
      const addLoopSlot = (i: number): void => {
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
        if (accountExportWork && consumers.accountExport) {
          loops.push(runLoop({ owner, consumer: consumers.accountExport, ...accountExportWork, workerLabel: `account-export-${i + 1}` }));
        }
      };
      growLoops = () => {
        const desired = Math.max(
          1,
          Math.floor(input.getComputePolicy().worker.maxExecutingPerWorker),
        );
        while (loopSlots < desired) {
          addLoopSlot(loopSlots);
          loopSlots += 1;
        }
      };
      if (emailDeliveryWork && consumers.emailDelivery) {
        loops.push(runLoop({
          owner,
          consumer: consumers.emailDelivery,
          ...emailDeliveryWork,
          workerLabel: 'email-delivery-1',
        }));
      }
      growLoops();
    },
    async stop(): Promise<void> {
      stopRequested = true;
      growLoops = null;
      scheduler.cancelWaiters();
      await Promise.allSettled(loops);
      loops = [];
    },
  };
}
