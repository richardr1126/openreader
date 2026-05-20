import type { TTSSentenceAlignment } from './types/tts';
import type { ParsedPdfDocument } from './types/parsed-pdf';

export type {
  TTSAudioBuffer,
  TTSAudioBytes,
  TTSSentenceAlignment,
  TTSSentenceWord,
} from './types/tts';
export type {
  ParsedPdfBlockKind,
  ParsedPdfBlockFragment,
  ParsedPdfBlock,
  ParsedPdfPage,
  ParsedPdfDocument,
} from './types/parsed-pdf';

export const ALIGN_QUEUE_NAME = 'whisper-align';
export const PDF_LAYOUT_QUEUE_NAME = 'pdf-layout';

export interface WhisperAlignJobRequest {
  text: string;
  lang?: string;
  cacheKey?: string;
  audioObjectKey: string;
}

export interface WhisperAlignJobResult {
  alignments: TTSSentenceAlignment[];
  timing?: WorkerJobTiming;
}

export interface PdfLayoutJobRequest {
  documentId: string;
  namespace: string | null;
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

export interface WorkerJobStatusResponse<Result> {
  status: WorkerJobState;
  result?: Result;
  error?: WorkerJobErrorShape;
  timing?: WorkerJobTiming;
}
