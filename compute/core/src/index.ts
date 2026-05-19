import type { TTSSentenceAlignment } from './types/tts';
import type { ParsedPdfDocument } from './types/parsed-pdf';
import { ensureWhisperModel } from './whisper/ensureModel';
import { alignAudioWithText } from './whisper/alignment';
import { ensureModel as ensurePdfLayoutModel } from './pdf-layout/ensureModel';
import { parsePdf } from './pdf-layout/parsePdf';

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

export interface PdfLayoutJobResult {
  parsed: ParsedPdfDocument;
  timing?: WorkerJobTiming;
}

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

export async function ensureComputeModels(): Promise<void> {
  await Promise.all([ensureWhisperModel(), ensurePdfLayoutModel()]);
}

export async function runWhisperAlignmentFromAudioBuffer(input: {
  audioBuffer: ArrayBuffer;
  text: string;
  cacheKey?: string;
  lang?: string;
}): Promise<WhisperAlignJobResult> {
  const alignments = await alignAudioWithText(
    input.audioBuffer,
    input.text,
    input.cacheKey,
    { lang: input.lang },
  );
  return { alignments };
}

export async function runPdfLayoutFromPdfBuffer(input: {
  documentId: string;
  pdfBytes: ArrayBuffer;
}): Promise<PdfLayoutJobResult> {
  const parsed = await parsePdf({
    documentId: input.documentId,
    pdfBytes: input.pdfBytes,
  });
  return { parsed };
}
