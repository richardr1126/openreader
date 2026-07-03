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
  paths['/v1/pdf-layout/jobs']['post']['requestBody']['content']['application/json'];
export type TtsPlaybackRequest =
  paths['/v1/tts-playback/sessions/jobs']['post']['requestBody']['content']['application/json']
  & { generationExtent?: 'window' | 'document' };
export type TtsPlaybackPlanRequest =
  Omit<TtsPlaybackRequest, 'sessionId' | 'planObjectKey' | 'generationRunId' | 'expiresAt' | 'aheadWindow' | 'backgroundExtent' | 'generationExtent'>;
export type PdfLayoutResolveRequest =
  paths['/v1/pdf-layout/resolve']['post']['requestBody']['content']['application/json'];
export type TtsPlaybackSessionResolveRequest =
  paths['/v1/tts-playback/sessions/resolve']['post']['requestBody']['content']['application/json'];
export type TtsPlaybackSessionResolution =
  paths['/v1/tts-playback/sessions/resolve']['post']['responses'][200]['content']['application/json'];
export type TtsPlaybackExportArtifactRequest =
  paths['/v1/tts-playback/exports/jobs']['post']['requestBody']['content']['application/json'];
export type TtsPlaybackExportArtifactResolveRequest =
  paths['/v1/tts-playback/exports/resolve']['post']['requestBody']['content']['application/json'];
export type TtsPlaybackExportArtifactResolution =
  paths['/v1/tts-playback/exports/resolve']['post']['responses'][200]['content']['application/json'];
export type TtsPlaybackExportArtifactMetadata =
  NonNullable<TtsPlaybackExportArtifactResolution['artifact']>;

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

export type TtsPlaybackExportArtifactResult = {
  artifact: TtsPlaybackExportArtifactMetadata;
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
  aheadWindow?: number | null;
  backgroundExtent?: 'section' | 'document' | null;
  generationExtent?: 'window' | 'document' | null;
  planning?: unknown;
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
  segmentKey: string | null;
  audioKey: string;
  durationMs: number;
  alignmentJson: string | null;
  updatedAt: number | null;
};

export type TtsPlaybackResetResult = {
  storageUserId: string;
  documentId: string;
  documentVersion: number | null;
  settingsHash: string | null;
  cacheEpoch: number;
  invalidatedPlaybackSessions: number;
  invalidatedSidecarCacheScopes: number;
  invalidatedJobOperations: number;
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
