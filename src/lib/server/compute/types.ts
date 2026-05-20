import type { TTSAudioBuffer, TTSSentenceAlignment, ParsedPdfDocument } from '@openreader/compute-core';

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

export interface ComputeBackend {
  mode: ComputeMode;
  alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult>;
  parsePdfLayout(input: PdfLayoutInput): Promise<ParsedPdfDocument>;
}
