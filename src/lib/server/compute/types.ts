import type { TTSAudioBuffer, TTSSentenceAlignment } from '@/types/tts';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';

export type ComputeMode = 'local' | 'worker' | 'none';

export interface WhisperAlignInput {
  audioBuffer: TTSAudioBuffer;
  text: string;
  cacheKey?: string;
  lang?: string;
}

export interface WhisperAlignResult {
  alignments: TTSSentenceAlignment[];
}

export interface PdfLayoutInput {
  documentId: string;
  pdfBytes: ArrayBuffer;
}

export interface ComputeBackend {
  mode: ComputeMode;
  alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult>;
  parsePdfLayout(input: PdfLayoutInput): Promise<ParsedPdfDocument>;
}

export class UnsupportedComputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedComputeError';
  }
}
