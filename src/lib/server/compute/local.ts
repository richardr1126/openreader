import type { ComputeBackend, PdfLayoutInput, WhisperAlignInput, WhisperAlignResult } from '@/lib/server/compute/types';
import { alignAudioWithText } from '@/lib/server/whisper/alignment';
import { parsePdf } from '@/lib/server/pdf-layout/parsePdf';

export class LocalComputeBackend implements ComputeBackend {
  readonly mode = 'local' as const;

  async alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult> {
    const alignments = await alignAudioWithText(
      input.audioBuffer,
      input.text,
      input.cacheKey,
      { engine: 'whisper.cpp', lang: input.lang },
    );
    return { alignments };
  }

  async parsePdfLayout(input: PdfLayoutInput) {
    return parsePdf({ documentId: input.documentId, pdfBytes: input.pdfBytes });
  }
}
