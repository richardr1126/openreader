import type { TTSAudioBuffer, TTSSentenceAlignment, ParsedPdfDocument } from '@openreader/compute-core/contracts';

export type ComputeMode = 'local' | 'worker';

export interface WhisperAlignInput {
  audioBuffer?: TTSAudioBuffer;
  audioObjectKey?: string;
  text: string;
  cacheKey?: string;
  lang?: string;
}

export interface WhisperAlignResult {
  alignments: TTSSentenceAlignment[];
}

export interface PdfLayoutInput {
  documentId: string;
  namespace?: string | null;
  documentObjectKey?: string;
  pdfBytes?: ArrayBuffer;
}

export type PdfLayoutResult =
  | { parsed: ParsedPdfDocument; parsedObjectKey?: never }
  | { parsed?: never; parsedObjectKey: string };

export interface ComputeBackend {
  mode: ComputeMode;
  alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult>;
  parsePdfLayout(input: PdfLayoutInput): Promise<PdfLayoutResult>;
}
