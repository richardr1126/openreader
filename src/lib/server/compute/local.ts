import type { ComputeBackend, PdfLayoutInput, WhisperAlignInput, WhisperAlignResult } from '@/lib/server/compute/types';
import { LOCAL_COMPUTE_LIMITER } from '@/lib/server/compute/concurrency-limiter';
import { getDocumentBlob } from '@/lib/server/documents/blobstore';
import { getTtsSegmentAudioObject } from '@/lib/server/tts/segments-blobstore';
import { getComputeTimeoutConfig } from '@openreader/compute-core/runtime/timeout-config';
import {
  runPdfLayoutFromPdfBuffer,
  runWhisperAlignmentFromAudioBuffer,
} from '@openreader/compute-core/local-runtime';
import type { PdfLayoutProgress } from '@openreader/compute-core/contracts';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withIdleTimeoutAndHardCap<T>(input: {
  run: (touchProgress: () => void) => Promise<T>;
  idleTimeoutMs: number;
  hardCapMs: number;
  label: string;
}): Promise<T> {
  let idleTimer: NodeJS.Timeout | null = null;
  let hardCapTimer: NodeJS.Timeout | null = null;
  let settled = false;
  let rejectTimeout!: (reason: unknown) => void;

  const clearTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (hardCapTimer) {
      clearTimeout(hardCapTimer);
      hardCapTimer = null;
    }
  };

  const failTimeout = (kind: 'idle' | 'hard cap', timeoutMs: number) => {
    if (settled) return;
    settled = true;
    clearTimers();
    rejectTimeout(new Error(`${input.label} ${kind} timed out after ${timeoutMs}ms`));
  };

  const touchProgress = () => {
    if (settled) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => failTimeout('idle', input.idleTimeoutMs), input.idleTimeoutMs);
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    hardCapTimer = setTimeout(() => failTimeout('hard cap', input.hardCapMs), input.hardCapMs);
    touchProgress();
  });

  try {
    const result = await Promise.race([input.run(touchProgress), timeoutPromise]);
    settled = true;
    clearTimers();
    return result as T;
  } catch (error) {
    settled = true;
    clearTimers();
    throw error;
  }
}

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
