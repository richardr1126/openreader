import type { ComputeBackend, PdfLayoutInput, WhisperAlignInput, WhisperAlignResult } from '@/lib/server/compute/types';
import { LOCAL_COMPUTE_LIMITER } from '@/lib/server/compute/concurrency-limiter';
import { getDocumentBlob } from '@/lib/server/documents/blobstore';
import { getTtsSegmentAudioObject } from '@/lib/server/tts/segments-blobstore';
import {
  getComputeTimeoutConfig,
  withIdleTimeoutAndHardCap,
  withTimeout,
  type PdfLayoutProgress,
} from '@openreader/compute-core';
import {
  runPdfLayoutFromPdfBuffer,
  runWhisperAlignmentFromAudioBuffer,
} from '@openreader/compute-core/local-runtime';

export class LocalComputeBackend implements ComputeBackend {
  readonly mode = 'local' as const;
  private readonly timeoutConfig = getComputeTimeoutConfig();

  async alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult> {
    return LOCAL_COMPUTE_LIMITER.run(async () => {
      let audioBuffer = input.audioBuffer ?? null;
      if (!audioBuffer && input.audioObjectKey) {
        const bytes = new Uint8Array(await getTtsSegmentAudioObject(input.audioObjectKey));
        audioBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      if (!audioBuffer) {
        throw new Error('Local compute alignment requires audioBuffer or audioObjectKey');
      }
      return withTimeout(
        runWhisperAlignmentFromAudioBuffer({
          audioBuffer,
          text: input.text,
          cacheKey: input.cacheKey,
          lang: input.lang,
        }),
        this.timeoutConfig.whisperTimeoutMs,
        'local whisper alignment job',
      );
    });
  }

  async parsePdfLayout(input: PdfLayoutInput) {
    return LOCAL_COMPUTE_LIMITER.run(async () => {
      let pdfBytes = input.pdfBytes ?? null;
      if (!pdfBytes && input.documentId && typeof input.namespace !== 'undefined') {
        const bytes = new Uint8Array(await getDocumentBlob(input.documentId, input.namespace));
        pdfBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      if (!pdfBytes) {
        throw new Error('Local compute PDF layout requires pdfBytes or (documentId + namespace)');
      }

      return {
        parsed: (await withIdleTimeoutAndHardCap({
          idleTimeoutMs: Math.max(this.timeoutConfig.pdfTimeoutMs, 1_000),
          hardCapMs: this.timeoutConfig.pdfHardCapMs,
          label: 'local pdf layout job',
          run: async (touchProgress) => runPdfLayoutFromPdfBuffer({
            documentId: input.documentId,
            pdfBytes,
            onPageParsed: (page) => {
              touchProgress();
              const progress: PdfLayoutProgress = {
                totalPages: page.totalPages,
                pagesParsed: page.pageNumber,
                currentPage: page.pageNumber,
                phase: 'infer',
              };
              return input.onProgress?.(progress);
            },
          }),
        })).parsed,
      };
    });
  }
}
