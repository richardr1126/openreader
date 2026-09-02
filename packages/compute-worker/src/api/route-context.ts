import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AccountExportJobResult,
  DocumentConversionJobResult,
  DocumentPreviewJobResult,
  PdfLayoutJobResult,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackJobResult,
  TtsPlaybackPlanJobResult,
  WorkerJobTiming,
  WorkerOperationEvent,
  WorkerOperationRequest,
  WorkerOperationState,
} from '../operations/contracts';
import type { StreamedOperationState } from '../operations/recovery';
import type { ReconciliationStateStore } from '../operations/reconciliation';
import type { ArtifactStorage } from '../infrastructure/storage';
import { toErrorMessage } from '../infrastructure/errors';
import type { TtsPlaybackStorage } from '../playback/storage';

export { toErrorMessage } from '../infrastructure/errors';

export type WorkerRouteResult =
  | PdfLayoutJobResult
  | TtsPlaybackJobResult
  | TtsPlaybackPlanJobResult
  | TtsPlaybackExportArtifactResult
  | DocumentPreviewJobResult
  | DocumentConversionJobResult
  | AccountExportJobResult;

export interface OperationEventStreamLike {
  subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: WorkerOperationEvent<WorkerRouteResult>) => void | Promise<void>;
    onError?: (error: unknown) => void;
  }): Promise<() => void>;
}

export interface OperationStateStoreLike extends ReconciliationStateStore {}

export interface OrchestratorLike {
  enqueueOrReuse(request: WorkerOperationRequest): Promise<WorkerOperationState>;
  markRunning(input: {
    opId: string;
    startedAt?: number;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markProgress(input: {
    opId: string;
    progress: WorkerOperationState['progress'];
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markSucceeded(input: {
    opId: string;
    result: unknown;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markFailed(input: {
    opId: string;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markFailedIfUnchanged?(input: {
    current: StreamedOperationState;
    expectedRevision: number;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
}

export interface ComputeWorkerRouteDeps {
  orchestrator: OrchestratorLike;
  operationStateStore: OperationStateStoreLike;
  operationEventStream: OperationEventStreamLike;
  artifactExists?: (key: string) => Promise<boolean>;
}

export interface ComputeWorkerRouteContext {
  app: FastifyInstance;
  deps: ComputeWorkerRouteDeps;
  storage: ArtifactStorage;
  playbackStorage?: TtsPlaybackStorage;
  s3Prefix: string;
  ensureOrphanedOpRecovery: () => Promise<void>;
  getOpState: (opId: string) => Promise<StreamedOperationState | null>;
  getNatsConnected: () => boolean;
  releaseHttp: (request: FastifyRequest) => void;
  markActivity: (reason: string) => void;
  onActiveSseChanged: (delta: number) => void;
}

export function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null;
}

export function isMissingObjectError(error: unknown): boolean {
  const maybe = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const message = toErrorMessage(error).toLowerCase();
  return maybe.$metadata?.httpStatusCode === 404
    || maybe.name === 'NotFound'
    || maybe.name === 'NoSuchKey'
    || maybe.Code === 'NotFound'
    || maybe.Code === 'NoSuchKey'
    || message.includes('specified key does not exist')
    || message.includes('no such key');
}

export function isTerminalStatus(status: import('../operations/contracts').WorkerJobState): boolean {
  return status === 'succeeded' || status === 'failed';
}
