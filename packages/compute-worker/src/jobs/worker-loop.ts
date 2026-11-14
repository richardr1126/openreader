import type { Consumer, JsMsg } from '@nats-io/jetstream';
import type {
  MaintenanceJobRequest,
  MaintenanceJobResult,
  AccountExportJobRequest,
  AccountExportJobResult,
  EmailDeliveryJobRequest,
  EmailDeliveryJobResult,
  ModelDownloadJobRequest,
  ModelDownloadJobResult,
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
import type { JobExecution, OperationAttemptUpdate, OperationExecution } from '../operations/types';
import { WORKER_HEARTBEAT_MS } from '../operations/delivery-policy';
import { pdfInputErrorCode } from '../inference/pdf/parse';
import type { JobHandlers } from './handlers';
import { buildQueueWaitTiming, decideRetryAction } from './worker-loop-policy';
import { toErrorMessage } from '../infrastructure/errors';
import { TtsCredentialBrokerClientError } from './tts-credential-broker-error';
import { EmailDeliveryError } from './email-delivery';
import { TtsProviderFailedError } from './playback/provider-failure';
import {
  type ComputeLimitPolicyDocument,
  type WorkerOperationAction,
} from '@openreader/runtime-config/compute-limits';
import {
  ComputeExecutionScheduler,
  type ComputeExecutionLease,
} from './execution-scheduler';

const LOOP_ERROR_BACKOFF_MS = 500;
const PULL_EXPIRES_MS = 5_000;

class ComputeQueueExpiredError extends Error {
  readonly code = 'COMPUTE_QUEUE_AGE_EXCEEDED';

  constructor() {
    super('Compute work expired before execution capacity became available');
    this.name = 'ComputeQueueExpiredError';
  }
}

/**
 * Queued work that never started because this worker stopped or its local
 * queue was full, and that its consumer will not redeliver. Failing it keeps
 * the operation from reading as queued forever.
 */
class ComputeWorkNotStartedError extends Error {
  readonly code = 'COMPUTE_WORK_NOT_STARTED';

  constructor(reason: 'rejected' | 'cancelled') {
    super(reason === 'rejected'
      ? 'Compute work was rejected because the worker queue is full'
      : 'Compute worker stopped before queued work could start');
    this.name = 'ComputeWorkNotStartedError';
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
  orchestrator: OperationExecution;
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
  modelDownloadCodec?: JsonCodec<QueuedJob<ModelDownloadJobRequest>>;
  maintenanceCodec?: JsonCodec<QueuedJob<MaintenanceJobRequest>>;
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
    deliveryAttempt: number;
    queueWaitTiming?: { queueWaitMs: number };
  };

  type JobRunner<TPayload, TResult> = (
    payload: TPayload,
    queueWaitMs: number,
    hooks: JobExecution<WorkerOperationProgress>,
  ) => Promise<TResult>;

  type WorkDefinition<TPayload, TResult> = {
    codec: JsonCodec<QueuedJob<TPayload>>;
    run: JobRunner<TPayload, TResult>;
    action?: WorkerOperationAction;
  };

  const attemptUpdate = <TPayload>(context: Context<TPayload>, updatedAt = Date.now()): OperationAttemptUpdate => ({
    opId: context.decoded.opId,
    deliveryAttempt: context.deliveryAttempt,
    updatedAt,
    timing: context.queueWaitTiming,
  });

  const notifyTerminal = async (opId: string, state: 'succeeded' | 'failed'): Promise<void> => {
    await input.onOperationTerminal?.({ operationId: opId, state }).catch((error) => input.logger.warn({
      opId,
      error: toErrorMessage(error),
    }, 'compute admission completion callback failed'));
  };

  const processMessage = async <TPayload, TResult>(work: WorkDefinition<TPayload, TResult> & {
    msg: JsMsg;
    workerLabel: string;
    notStarted?: ComputeQueueExpiredError | ComputeWorkNotStartedError;
  }): Promise<void> => {
    let context: Context<TPayload> | null = null;
    let decodedMessage = false;
    let heartbeat: NodeJS.Timeout | null = null;
    const controller = new AbortController();
    let heartbeatPending = false;
    // State writes for one job apply in order, so a heartbeat or progress
    // update still in flight cannot land after (and hide) the terminal state.
    let stateWrites: Promise<unknown> = Promise.resolve();
    const writeState = <T>(write: () => Promise<T>): Promise<T> => {
      const next = stateWrites.then(write, write);
      stateWrites = next.catch(() => undefined);
      return next;
    };
    const stopHeartbeat = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };
    try {
      const decoded = work.codec.decode(work.msg.data);
      decodedMessage = true;
      const startedAt = Date.now();
      const maxQueueAgeMs = work.action
        ? input.getComputePolicy().actions[work.action].execution!.maxQueueAgeSeconds * 1000
        : Math.max(1, decoded.payload && typeof decoded.payload === 'object' && 'expiresAt' in decoded.payload
          ? Number((decoded.payload as { expiresAt: number }).expiresAt) - decoded.queuedAt
          : 60 * 60 * 1000);
      const delivery = {
        decoded,
        workerLabel: work.workerLabel,
        deliveryAttempt: work.msg.info.deliveryCount,
        queueWaitTiming: buildQueueWaitTiming(decoded.queuedAt, startedAt),
      };
      const claim = await input.orchestrator.claimAttempt({
        ...attemptUpdate(delivery, startedAt),
        jobId: decoded.jobId,
      });
      if (claim === 'superseded') return;
      if (claim === 'missing') {
        work.msg.term('Operation is no longer available');
        return;
      }
      if (claim !== 'claimed') {
        await notifyTerminal(decoded.opId, claim);
        work.msg.ack();
        return;
      }
      context = delivery;
      if (work.notStarted) throw work.notStarted;
      if (WORKER_OPERATION_KIND_POLICY[decoded.kind].enforcesQueueDeadline && startedAt - decoded.queuedAt > maxQueueAgeMs) {
        throw new ComputeQueueExpiredError();
      }
      input.logger.info({
        worker: work.workerLabel,
        kind: decoded.kind,
        opId: decoded.opId,
        jobId: decoded.jobId,
        queueWaitMs: context.queueWaitTiming?.queueWaitMs ?? null,
        deliveryCount: work.msg.info.deliveryCount,
      }, 'job.started');
      const report = async (progress?: WorkerOperationProgress): Promise<boolean> => {
        const active = await writeState(() => input.orchestrator.updateAttempt({
          ...attemptUpdate(delivery),
          progress,
        }));
        if (!active) {
          stopHeartbeat();
          controller.abort(new Error('Operation attempt no longer owns execution'));
          return false;
        }
        try {
          work.msg.working();
        } catch (error) {
          input.logger.warn({
            worker: work.workerLabel,
            opId: decoded.opId,
            jobId: decoded.jobId,
            error: toErrorMessage(error),
          }, 'failed to extend JetStream ack wait');
        }
        return true;
      };
      heartbeat = setInterval(() => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        void report().catch((error) => {
          input.logger.error({
            worker: work.workerLabel,
            opId: decoded.opId,
            jobId: decoded.jobId,
            error: toErrorMessage(error),
          }, 'failed to renew operation heartbeat');
        }).finally(() => {
          heartbeatPending = false;
        });
      }, WORKER_HEARTBEAT_MS);
      const result = await work.run(decoded.payload, delivery.queueWaitTiming?.queueWaitMs ?? 0, {
        opId: decoded.opId,
        operationKey: decoded.opKey,
        attempt: delivery.deliveryAttempt,
        signal: controller.signal,
        assertActive: async () => {
          if (!await report()) throw controller.signal.reason;
        },
        onProgress: async (progress) => {
          if (!await report(progress)) throw controller.signal.reason;
        },
      });
      const timing = extractTiming(result);
      const now = Date.now();
      stopHeartbeat();
      const settled = await writeState(() => input.orchestrator.settleAttempt({
        ...attemptUpdate(delivery, now),
        status: 'succeeded',
        result,
        timing: timing ?? delivery.queueWaitTiming,
      }));
      if (!settled) return;
      await notifyTerminal(decoded.opId, 'succeeded');
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
      if (!context && decodedMessage) {
        input.logger.error({ worker: work.workerLabel, error: errorMessage }, 'failed to claim operation attempt');
        return;
      }
      const deliveryCount = work.msg.info.deliveryCount;
      const kind = context?.decoded.kind ?? 'pdf_layout';
      const inputErrorCode = kind === 'pdf_layout' ? pdfInputErrorCode(error) : undefined;
      const retryable = inputErrorCode ? false
        : error instanceof TtsCredentialBrokerClientError || error instanceof EmailDeliveryError || error instanceof TtsProviderFailedError
          ? error.retryable : undefined;
      const notStarted = error instanceof ComputeQueueExpiredError || error instanceof ComputeWorkNotStartedError;
      const action = notStarted
        ? 'term'
        : decideRetryAction({
          kind,
          deliveryCount,
          pdfAttempts: input.pdfAttempts,
          retryable,
        });
      stopHeartbeat();
      if (context) {
        const failedContext = context;
        const update = writeState(() => (action === 'nak_retry'
          ? input.orchestrator.updateAttempt(attemptUpdate(failedContext))
          : input.orchestrator.settleAttempt({
            ...attemptUpdate(failedContext),
            status: 'failed',
            error: {
              message: errorMessage,
              ...(inputErrorCode ? { code: inputErrorCode }
                : notStarted || error instanceof TtsProviderFailedError ? { code: error.code } : {}),
            },
          })));
        try {
          if (!await update) return;
        } catch (stateError) {
          input.logger.error({
            worker: context.workerLabel,
            opId: context.decoded.opId,
            jobId: context.decoded.jobId,
            error: toErrorMessage(stateError),
          }, 'failed to persist operation state');
          return;
        }
        if (action !== 'nak_retry') await notifyTerminal(context.decoded.opId, 'failed');
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
      stopHeartbeat();
      controller.abort();
    }
  };

  const handleMessage = async <TPayload, TResult>(work: WorkDefinition<TPayload, TResult> & {
    msg: JsMsg;
    workerLabel: string;
  }, detached: () => boolean): Promise<'continue' | 'return'> => {
    const { msg } = work;
    let executionLease: ComputeExecutionLease | null = null;
    input.markActivity(`job_received:${work.workerLabel}`);
    input.onInFlightJobsChanged(1);
    try {
      const queueHeartbeat = setInterval(() => {
        try {
          msg.working();
        } catch {
          // A detached or redelivered message is handled by the normal loop path.
        }
      }, WORKER_HEARTBEAT_MS);
      try {
        if (work.action) {
          const acquisition = await scheduler.acquire(work.action);
          if (acquisition.status === 'acquired') executionLease = acquisition.lease;
          else if (acquisition.status === 'expired') {
            await processMessage({ ...work, notStarted: new ComputeQueueExpiredError() });
            return 'continue';
          } else if (!canRedeliver(work, msg)) {
            await processMessage({ ...work, notStarted: new ComputeWorkNotStartedError(acquisition.status) });
            return 'continue';
          }
        }
      } finally {
        clearInterval(queueHeartbeat);
      }
      if (work.action && !executionLease) {
        msg.nak();
        return 'continue';
      }
      if (detached()) {
        msg.nak();
        return 'return';
      }
      await processMessage(work);
      return 'continue';
    } finally {
      if (executionLease) scheduler.release(executionLease);
      input.onInFlightJobsChanged(-1);
      input.markActivity(`job_completed:${work.workerLabel}`);
    }
  };

  const canRedeliver = <TPayload, TResult>(work: WorkDefinition<TPayload, TResult>, msg: JsMsg): boolean => {
    try {
      return decideRetryAction({
        kind: work.codec.decode(msg.data).kind,
        deliveryCount: msg.info.deliveryCount,
        pdfAttempts: input.pdfAttempts,
      }) === 'nak_retry';
    } catch {
      return true;
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
        msg = await work.consumer.next({ expires: PULL_EXPIRES_MS });
      } catch (error) {
        if (detached()) return;
        input.logger.error({ error: toErrorMessage(error), worker: work.workerLabel }, 'worker pull failed');
        await sleep(LOOP_ERROR_BACKOFF_MS);
        continue;
      }
      if (!msg) continue;
      if (await handleMessage({ ...work, msg }, detached) === 'return') return;
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
      ttsPlaybackDocument?: Consumer;
      ttsPlaybackPlan?: Consumer;
      ttsPlaybackExport?: Consumer;
      documentPreview?: Consumer;
      documentConversion?: Consumer;
      accountExport?: Consumer;
      emailDelivery?: Consumer;
      modelDownload?: Consumer;
      maintenance?: Consumer;
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
      const ttsPlaybackDocumentWork: WorkDefinition<TtsPlaybackJobRequest, TtsPlaybackJobResult> | null =
        input.ttsPlaybackCodec && consumers.ttsPlaybackDocument
          ? {
            codec: input.ttsPlaybackCodec,
            run: input.handlers.runTtsPlayback,
            action: 'tts_playback_document',
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
      const modelDownloadWork: WorkDefinition<ModelDownloadJobRequest, ModelDownloadJobResult> | null =
        input.modelDownloadCodec && consumers.modelDownload && input.handlers.runModelDownload
          ? { codec: input.modelDownloadCodec, run: input.handlers.runModelDownload }
          : null;
      let loopSlots = 0;
      const maintenanceWork: WorkDefinition<MaintenanceJobRequest, MaintenanceJobResult> | null =
        input.maintenanceCodec && consumers.maintenance && input.handlers.runMaintenance
          ? { codec: input.maintenanceCodec, run: input.handlers.runMaintenance }
          : null;
      if (maintenanceWork && consumers.maintenance) {
        loops.push(runLoop({ owner, consumer: consumers.maintenance, ...maintenanceWork, workerLabel: 'maintenance-1' }));
      }
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
      // Whole-document runs pull only as many messages as this worker may
      // execute; queued exports stay in JetStream for any replica with a free
      // slot instead of waiting (for hours) inside one worker.
      let documentLoopSlots = 0;
      growLoops = () => {
        const policy = input.getComputePolicy();
        const desired = Math.max(1, Math.floor(policy.worker.maxExecutingPerWorker));
        while (loopSlots < desired) {
          addLoopSlot(loopSlots);
          loopSlots += 1;
        }
        if (!ttsPlaybackDocumentWork || !consumers.ttsPlaybackDocument) return;
        const documentConsumer = consumers.ttsPlaybackDocument;
        const desiredDocument = Math.max(1, Math.min(
          desired,
          Math.floor(policy.actions.tts_playback_document.execution!.maxConcurrentPerWorker),
        ));
        while (documentLoopSlots < desiredDocument) {
          documentLoopSlots += 1;
          loops.push(runLoop({
            owner,
            consumer: documentConsumer,
            ...ttsPlaybackDocumentWork,
            workerLabel: `tts-playback-document-${documentLoopSlots}`,
          }));
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
      // One download at a time is enough: a model is shared by every job.
      if (modelDownloadWork && consumers.modelDownload) {
        loops.push(runLoop({
          owner,
          consumer: consumers.modelDownload,
          ...modelDownloadWork,
          workerLabel: 'model-download-1',
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
