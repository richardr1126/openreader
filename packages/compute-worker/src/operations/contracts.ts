import type { ParsedPdfDocument } from '../api/types';

export type {
  TTSAudioBuffer,
  TTSAudioBytes,
  TTSSentenceAlignment,
  TTSSentenceWord,
} from '../api/types';
export type {
  ParsedPdfBlockKind,
  ParsedPdfBlockFragment,
  ParsedPdfBlock,
  ParsedPdfPage,
  ParsedPdfDocument,
} from '../api/types';

export const PDF_PARSER_VERSION = 'pp-doclayoutv3-onnx@800+pdfjs@4.8.69';
export const DOCUMENT_PREVIEW_RENDERER_VERSION = 'document-preview@pdfjs-4.8.69+epub-cover-v1';
export const DOCX_CONVERTER_VERSION = 'docx-to-pdf@libreoffice-v1';

export function encodeParserVersion(parserVersion: string, defaultVersion = PDF_PARSER_VERSION): string {
  return encodeURIComponent(parserVersion.trim() || defaultVersion);
}

export interface PdfLayoutJobBase {
  documentId: string;
  namespace: string | null;
}

export interface PdfLayoutJobRequest extends PdfLayoutJobBase {
  documentObjectKey: string;
}

export interface TtsPlaybackJobRequest {
  sessionId: string;
  userId: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  settingsJson: unknown;
  planObjectKey: string;
  /**
   * Distinguishes bounded generation runs for the same session. Initial session
   * creation may omit this; cursor-driven continuations set a fresh token so the
   * operation dedupe key does not reuse a prior terminal run.
   */
  generationRunId?: string;
  /** Absolute epoch-ms expiry for the ephemeral playback session. */
  expiresAt?: number;
  /**
   * How many segments ahead of the client's playback cursor the worker may
   * generate while the client is connected (cursor is fresh). When the cursor
   * goes stale (client disconnected / JS suspended) the worker stops honoring
   * this window and generates forward up to the `backgroundExtent` boundary so
   * background playback survives. Omitted ⇒ a small default window.
   */
  aheadWindow?: number;
  /**
   * On disconnect, how far the worker keeps generating so background playback
   * continues without the client: 'section' = finish the current PDF page /
   * EPUB chapter; 'document' = generate to the end of the forward plan.
   */
  backgroundExtent?: 'section' | 'document';
  /**
   * Export/download runs are not playback-window bounded. They fill the whole
   * forward plan even while the cursor is fresh.
   */
  generationExtent?: 'window' | 'document';
  planning: {
    /** Optional absolute worker-plan ordinal selected by the UI from a known plan row. */
    selectedOrdinal?: number;
    maxBlockLength?: number;
    enforceSourceBoundaries?: boolean;
    language?: string;
    /**
     * Worker-owned derivation input. The worker reads the document artifact and
     * derives source units itself, so generation can continue independently of
     * the client. `extent` bounds how far ahead the worker generates.
     */
    documentSource?: {
      namespace: string | null;
      skipBlockKinds?: string[];
      extent: 'section' | 'document';
      /** HTML: parse as plain text (.txt) rather than markdown. */
      isPlainText?: boolean;
    };
  };
}

export interface TtsPlaybackJobResult {
  sessionId: string;
  planObjectKey?: string;
  timing?: WorkerJobTiming;
}

export interface TtsPlaybackPlanJobRequest {
  userId: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  settingsJson: unknown;
  planning: TtsPlaybackJobRequest['planning'];
}

export interface TtsPlaybackPlanJobResult {
  planObjectKey: string;
  planSignature: string;
  startOrdinal: number;
  plannedCount: number;
  timing?: WorkerJobTiming;
}

export type TtsPlaybackExportFormat = 'mp3' | 'm4b';

export interface TtsPlaybackExportArtifactRequest {
  artifactId: string;
  sessionId: string;
  userId: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  settingsJson: unknown;
  planObjectKey: string;
  format: TtsPlaybackExportFormat;
  speed: number;
}

export interface TtsPlaybackExportArtifactMetadata {
  schemaVersion: 1;
  artifactId: string;
  sessionId: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  planObjectKey: string;
  format: TtsPlaybackExportFormat;
  speed: number;
  objectKey: string;
  contentType: string;
  byteLength: number;
  dispositionFilename: string;
  sourceSessionId: string;
  sourcePlanObjectKey: string;
  status: 'ready';
  createdAt: number;
}

export interface TtsPlaybackExportArtifactResult {
  artifact: TtsPlaybackExportArtifactMetadata;
  timing?: WorkerJobTiming;
}

export type DocumentPreviewKind = 'card';

export interface DocumentPreviewJobRequest {
  documentId: string;
  namespace: string | null;
  documentType: 'pdf' | 'epub';
  sourceObjectKey: string;
  sourceLastModifiedMs: number;
  previewKind: DocumentPreviewKind;
  rendererVersion?: string;
  targetWidth?: number;
}

export interface DocumentPreviewArtifactMetadata {
  schemaVersion: 1;
  documentId: string;
  namespace: string | null;
  documentType: 'pdf' | 'epub';
  sourceObjectKey: string;
  sourceLastModifiedMs: number;
  previewKind: DocumentPreviewKind;
  rendererVersion: string;
  objectKey: string;
  metadataObjectKey: string;
  contentType: 'image/jpeg';
  width: number;
  height: number | null;
  byteLength: number;
  eTag: string | null;
  status: 'ready';
  createdAt: number;
}

export interface DocumentPreviewJobResult {
  artifact: DocumentPreviewArtifactMetadata;
  timing?: WorkerJobTiming;
}

export interface DocumentConversionJobRequest {
  conversionId: string;
  namespace: string | null;
  sourceObjectKey: string;
  sourceLastModifiedMs: number;
  sourceContentType: string;
  sourceEtag?: string | null;
  converterVersion?: string;
}

export interface DocumentConversionArtifactMetadata {
  schemaVersion: 1;
  conversionId: string;
  namespace: string | null;
  sourceObjectKey: string;
  sourceLastModifiedMs: number;
  sourceContentType: string;
  sourceEtag: string | null;
  converterVersion: string;
  objectKey: string;
  metadataObjectKey: string;
  contentType: 'application/pdf';
  byteLength: number;
  documentId: string;
  status: 'ready';
  createdAt: number;
}

export interface DocumentConversionJobResult {
  artifact: DocumentConversionArtifactMetadata;
  timing?: WorkerJobTiming;
}

export interface AccountExportJobRequest {
  artifactId: string;
  userId: string;
  storageUserId: string;
  namespace: string | null;
  schemaVersion: number;
  manifestHash: string;
  manifestObjectKey: string;
}

export interface AccountExportArtifactMetadata {
  schemaVersion: 1;
  artifactId: string;
  userId: string;
  storageUserId: string;
  namespace: string | null;
  exportSchemaVersion: number;
  manifestHash: string;
  manifestObjectKey: string;
  objectKey: string;
  contentType: 'application/zip';
  byteLength: number;
  dispositionFilename: string;
  status: 'ready';
  createdAt: number;
}

export interface AccountExportJobResult {
  artifact: AccountExportArtifactMetadata;
  timing?: WorkerJobTiming;
}

export type PdfLayoutJobResult =
  | {
    parsed: ParsedPdfDocument;
    parsedObjectKey?: never;
    timing?: WorkerJobTiming;
  }
  | {
    parsed?: never;
    parsedObjectKey: string;
    timing?: WorkerJobTiming;
  };

export type WorkerJobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface WorkerJobErrorShape {
  message: string;
  code?: string;
}

export interface WorkerJobTiming {
  queueWaitMs?: number;
  s3FetchMs?: number;
  computeMs?: number;
}

export type PdfLayoutProgressPhase = 'infer' | 'merge';

export interface PdfLayoutProgress {
  totalPages: number;
  pagesParsed: number;
  currentPage?: number;
  phase: PdfLayoutProgressPhase;
}

/**
 * Lightweight progress watermark for a TTS playback job, pushed to the client via
 * the operation-events SSE channel. `completedCount` is the authoritative count
 * of generated sidecars for the plan, including audio that existed before this
 * run. `completedThroughOrdinal` remains a lightweight wake-up watermark for
 * live playback/timeline refreshes.
 */
export interface TtsPlaybackProgress {
  completedThroughOrdinal: number;
  completedCount: number;
  plannedCount: number;
}

export interface TtsPlaybackExportProgress {
  phase: 'assembling' | 'transcoding' | 'uploading';
  completedSegments: number;
  plannedSegments: number;
}

export interface DocumentConversionProgress {
  phase: 'fetching' | 'converting' | 'uploading';
}

export interface AccountExportProgress {
  phase: 'assembling' | 'uploading';
  completedFiles: number;
  plannedFiles: number;
}

export type WorkerOperationProgress =
  | PdfLayoutProgress
  | TtsPlaybackProgress
  | TtsPlaybackExportProgress
  | DocumentConversionProgress
  | AccountExportProgress;

export type WorkerOperationKind =
  | 'pdf_layout'
  | 'tts_playback'
  | 'tts_playback_plan'
  | 'tts_playback_export'
  | 'document_preview'
  | 'document_conversion'
  | 'account_export';

/**
 * Per-kind operation policy. The exhaustive Record forces every new operation
 * kind to declare its policy here instead of growing kind-switches in the
 * state machine or worker loop.
 *
 * `reusesSucceeded`: whether a succeeded operation record satisfies a new
 * request for the same opKey. Kinds marked `false` treat durable artifacts
 * (playback plans/segments, previews, conversions) as the reusable cache and
 * replace terminal operation records so each request re-verifies current
 * artifact/sidecar state.
 *
 * `slowJobLogThresholdMs`: compute duration above which the worker loop logs
 * the job as slow.
 */
export const WORKER_OPERATION_KIND_POLICY: Record<WorkerOperationKind, {
  reusesSucceeded: boolean;
  slowJobLogThresholdMs: number;
}> = {
  pdf_layout: { reusesSucceeded: true, slowJobLogThresholdMs: 120_000 },
  tts_playback: { reusesSucceeded: false, slowJobLogThresholdMs: 30_000 },
  tts_playback_plan: { reusesSucceeded: false, slowJobLogThresholdMs: 30_000 },
  tts_playback_export: { reusesSucceeded: false, slowJobLogThresholdMs: 120_000 },
  document_preview: { reusesSucceeded: false, slowJobLogThresholdMs: 120_000 },
  document_conversion: { reusesSucceeded: false, slowJobLogThresholdMs: 120_000 },
  account_export: { reusesSucceeded: true, slowJobLogThresholdMs: 120_000 },
};

export interface PdfLayoutOperationRequest {
  kind: 'pdf_layout';
  opKey: string;
  payload: PdfLayoutJobRequest;
}

export interface TtsPlaybackOperationRequest {
  kind: 'tts_playback';
  opKey: string;
  payload: TtsPlaybackJobRequest;
}

export interface TtsPlaybackPlanOperationRequest {
  kind: 'tts_playback_plan';
  opKey: string;
  payload: TtsPlaybackPlanJobRequest;
}

export interface TtsPlaybackExportArtifactOperationRequest {
  kind: 'tts_playback_export';
  opKey: string;
  payload: TtsPlaybackExportArtifactRequest;
}

export interface DocumentPreviewOperationRequest {
  kind: 'document_preview';
  opKey: string;
  payload: DocumentPreviewJobRequest;
}

export interface DocumentConversionOperationRequest {
  kind: 'document_conversion';
  opKey: string;
  payload: DocumentConversionJobRequest;
}

export interface AccountExportOperationRequest {
  kind: 'account_export';
  opKey: string;
  payload: AccountExportJobRequest;
}

export type WorkerOperationRequest =
  | PdfLayoutOperationRequest
  | TtsPlaybackOperationRequest
  | TtsPlaybackPlanOperationRequest
  | TtsPlaybackExportArtifactOperationRequest
  | DocumentPreviewOperationRequest
  | DocumentConversionOperationRequest
  | AccountExportOperationRequest;

export interface WorkerOperationState<Result = unknown> {
  opId: string;
  opKey: string;
  kind: WorkerOperationKind;
  jobId: string;
  status: WorkerJobState;
  queuedAt: number;
  updatedAt: number;
  startedAt?: number;
  result?: Result;
  error?: WorkerJobErrorShape;
  timing?: WorkerJobTiming;
  progress?: WorkerOperationProgress;
}

export interface WorkerOperationEvent<Result = unknown> {
  eventId: number;
  snapshot: WorkerOperationState<Result>;
}
