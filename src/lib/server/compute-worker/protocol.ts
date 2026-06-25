import type { components, paths } from './generated';

export type ParsedPdfDocument = components['schemas']['ParsedPdfDocument'];
export type ParsedPdfPage = ParsedPdfDocument['pages'][number];
export type ParsedPdfBlock = ParsedPdfPage['blocks'][number];
export type ParsedPdfBlockKind = ParsedPdfBlock['kind'];
export type ParsedPdfBlockFragment = ParsedPdfBlock['fragments'][number];

export type TTSSentenceAlignment = components['schemas']['TTSSentenceAlignment'];
export type TTSSentenceWord = TTSSentenceAlignment['words'][number];

export type PdfLayoutProgress = NonNullable<components['schemas']['ComputeOperation']['progress']>;
export type ComputeOperationStatus = components['schemas']['ComputeOperation']['status'];
export type ComputeOperationSubject = components['schemas']['ComputeOperation']['subject'];

export type ComputeOperation<Result = unknown> =
  Omit<components['schemas']['ComputeOperation'], 'result'>
  & { result?: Result };

export type ComputeOperationEvent<Result = unknown> = {
  eventId: number;
  snapshot: ComputeOperation<Result>;
};

export type PdfLayoutRequest =
  paths['/v1/pdf-layout/operations']['post']['requestBody']['content']['application/json'];
export type TtsPlaybackRequest =
  paths['/v1/tts-playback/operations']['post']['requestBody']['content']['application/json'];
export type TtsPlaybackPlanRequest =
  Omit<TtsPlaybackRequest, 'sessionId' | 'planObjectKey' | 'generationRunId' | 'expiresAt' | 'aheadWindow' | 'backgroundExtent'>;
export type PdfLayoutResolveRequest =
  paths['/v1/pdf-layout/resolve']['post']['requestBody']['content']['application/json'];

export type PdfLayoutResult = {
  parsedObjectKey: string;
  timing?: components['schemas']['ComputeOperation']['timing'];
};

export type TtsPlaybackResult = {
  sessionId: string;
  planObjectKey?: string;
  timing?: components['schemas']['ComputeOperation']['timing'];
};

export type TtsPlaybackPlanResult = {
  planObjectKey: string;
  planSignature: string;
  startOrdinal: number;
  plannedCount: number;
  timing?: components['schemas']['ComputeOperation']['timing'];
};

export type TtsPlaybackSessionState = {
  schemaVersion: 1;
  sessionId: string;
  userId: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  workerOpId?: string | null;
  settingsHash: string;
  settingsJson: unknown;
  generationStartOrdinal: number;
  cursorOrdinal: number;
  cursorUpdatedAt: number | null;
  planObjectKey: string | null;
  expiresAt: number;
  lastError: string | null;
  updatedAt: number;
};

export type TtsPlaybackCompletedSegment = {
  ordinal: number;
  sourceSegmentIndex: number;
  segmentKey: string | null;
  segmentId: string;
  audioKey: string;
  durationMs: number;
  alignmentJson: string | null;
  updatedAt: number | null;
};

export type PdfLayoutResolution = {
  artifact: { objectKey: string } | null;
  operation: ComputeOperation<PdfLayoutResult> | null;
};

export function isComputeOperation(value: unknown): value is ComputeOperation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.opId === 'string'
    && !!record.subject
    && typeof record.subject === 'object'
    && typeof (record.subject as Record<string, unknown>).kind === 'string'
    && typeof record.status === 'string'
    && typeof record.queuedAt === 'number'
    && typeof record.updatedAt === 'number';
}
