import type { TTSSentenceAlignment } from '../types/tts';
import type { ParsedPdfDocument } from '../types/parsed-pdf';

export type {
  TTSAudioBuffer,
  TTSAudioBytes,
  TTSSentenceAlignment,
  TTSSentenceWord,
} from '../types/tts';
export type {
  ParsedPdfBlockKind,
  ParsedPdfBlockFragment,
  ParsedPdfBlock,
  ParsedPdfPage,
  ParsedPdfDocument,
} from '../types/parsed-pdf';

export const ALIGN_QUEUE_NAME = 'whisper-align';
export const PDF_LAYOUT_QUEUE_NAME = 'pdf-layout';

export interface WhisperAlignJobBase {
  text: string;
  lang?: string;
  cacheKey?: string;
}

export interface WhisperAlignJobRequest extends WhisperAlignJobBase {
  audioObjectKey: string;
}

export interface WhisperAlignJobResult {
  alignments: TTSSentenceAlignment[];
  timing?: WorkerJobTiming;
}

export interface PdfLayoutJobBase {
  documentId: string;
  namespace: string | null;
}

export interface PdfLayoutJobRequest extends PdfLayoutJobBase {
  documentObjectKey: string;
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

export interface WorkerJobStatusResponse<Result> {
  status: WorkerJobState;
  result?: Result;
  error?: WorkerJobErrorShape;
  timing?: WorkerJobTiming;
}

export type WorkerOperationKind = 'whisper_align' | 'pdf_layout';

export interface WhisperAlignOperationRequest {
  kind: 'whisper_align';
  opKey: string;
  payload: WhisperAlignJobRequest;
}

export interface PdfLayoutOperationRequest {
  kind: 'pdf_layout';
  opKey: string;
  payload: PdfLayoutJobRequest;
}

export type WorkerOperationRequest = WhisperAlignOperationRequest | PdfLayoutOperationRequest;

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
  progress?: PdfLayoutProgress;
}

export interface WorkerOperationEvent<Result = unknown> {
  eventId: number;
  snapshot: WorkerOperationState<Result>;
}
