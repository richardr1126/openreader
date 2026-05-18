import type { ComputeBackend, PdfLayoutInput, WhisperAlignInput, WhisperAlignResult } from '@/lib/server/compute/types';
import { UnsupportedComputeError } from '@/lib/server/compute/types';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';

export class NoneComputeBackend implements ComputeBackend {
  readonly mode = 'none' as const;

  async alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult> {
    void input;
    throw new UnsupportedComputeError('Word alignment is unavailable: OPENREADER_COMPUTE_MODE=none');
  }

  async parsePdfLayout(input: PdfLayoutInput): Promise<ParsedPdfDocument> {
    void input;
    throw new UnsupportedComputeError('PDF layout parsing is unavailable: OPENREADER_COMPUTE_MODE=none');
  }
}
