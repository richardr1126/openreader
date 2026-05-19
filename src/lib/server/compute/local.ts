import type { ComputeBackend, PdfLayoutInput, WhisperAlignInput, WhisperAlignResult } from '@/lib/server/compute/types';

export class LocalComputeBackend implements ComputeBackend {
  readonly mode = 'local' as const;

  async alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult> {
    const { alignAudioWithText } = await import('@/lib/server/whisper/alignment');
    const alignments = await alignAudioWithText(
      input.audioBuffer,
      input.text,
      input.cacheKey,
      { lang: input.lang },
    );
    return { alignments };
  }

  async parsePdfLayout(input: PdfLayoutInput) {
    const { parsePdf } = await import('@/lib/server/pdf-layout/parsePdf');
    return parsePdf({ documentId: input.documentId, pdfBytes: input.pdfBytes });
  }
}
