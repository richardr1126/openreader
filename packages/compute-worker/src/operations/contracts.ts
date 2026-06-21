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

export const PDF_LAYOUT_QUEUE_NAME = 'pdf-layout';
export const TTS_PLAYBACK_QUEUE_NAME = 'tts-playback';
export const TTS_PLAYBACK_PLAN_QUEUE_NAME = 'tts-playback-plan';
export const PDF_PARSER_VERSION = 'pp-doclayoutv3-onnx@800+pdfjs@4.8.69';

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
  planObjectKey?: string;
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
  planning: {
    startSegmentKey?: string;
    startText?: string;
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
      /** PDF: 1-based page to start generating from. */
      startPage?: number;
      /** EPUB: 0-based spine index to start generating from. */
      startSpineIndex?: number;
      /** EPUB: normalized chapter-relative character offset to start at. */
      startCharOffset?: number;
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
 * the operation-events SSE channel. `completedThroughOrdinal` is the highest
 * contiguous plan ordinal whose audio is ready; the client reacts by refetching
 * the timeline and nudging the audio engine to discover the new segments.
 */
export interface TtsPlaybackProgress {
  completedThroughOrdinal: number;
  plannedCount: number;
}

export type WorkerOperationProgress = PdfLayoutProgress | TtsPlaybackProgress;

export interface WorkerJobStatusResponse<Result> {
  status: WorkerJobState;
  result?: Result;
  error?: WorkerJobErrorShape;
  timing?: WorkerJobTiming;
}

export type WorkerOperationKind = 'pdf_layout' | 'tts_playback' | 'tts_playback_plan';

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

export type WorkerOperationRequest =
  | PdfLayoutOperationRequest
  | TtsPlaybackOperationRequest
  | TtsPlaybackPlanOperationRequest;

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
