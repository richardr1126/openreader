import type {
  TTSAudioBuffer,
  TTSSentenceAlignment,
  ParsedPdfDocument,
} from '@openreader/compute-core/types';
import type { PdfLayoutProgress, WhisperAlignJobBase } from '@openreader/compute-core/api-contracts';
import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';

export interface WhisperAlignInput extends WhisperAlignJobBase {
  audioBuffer?: TTSAudioBuffer;
  audioObjectKey?: string;
}

export interface WhisperAlignResult {
  alignments: TTSSentenceAlignment[];
}

export interface PdfLayoutInput {
  documentId: string;
  namespace?: string | null;
  documentObjectKey?: string;
  pdfBytes?: ArrayBuffer;
  forceToken?: string;
  onProgress?: (progress: PdfLayoutProgress) => void | Promise<void>;
  onWorkerSnapshot?: (snapshot: WorkerOperationState<PdfLayoutJobResult>) => void | Promise<void>;
}

export type PdfLayoutResult =
  | { parsed: ParsedPdfDocument; parsedObjectKey?: never }
  | { parsed?: never; parsedObjectKey: string };

export interface ComputeBackend {
  mode: 'worker';
  alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult>;
  parsePdfLayout(input: PdfLayoutInput): Promise<PdfLayoutResult>;
}
