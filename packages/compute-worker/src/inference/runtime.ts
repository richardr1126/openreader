import { ensureWhisperModel } from './whisper/model';
import { alignAudioWithText } from './whisper/align';
import { ensureModel as ensurePdfLayoutModel } from './pdf/model';
import { parsePdf } from './pdf/parse';
import type { ModelDownloadProgressHandler } from './model-download';

export async function ensureComputeModels(): Promise<void> {
  await Promise.all([ensureWhisperModel(), ensurePdfLayoutModel()]);
}

export async function runWhisperAlignmentFromAudioBuffer(input: {
  audioBuffer: ArrayBuffer;
  text: string;
  cacheKey?: string;
  lang?: string;
  onModelDownloadProgress?: ModelDownloadProgressHandler;
  shouldStart?: () => boolean | Promise<boolean>;
}) {
  const alignments = await alignAudioWithText(
    input.audioBuffer,
    input.text,
    input.cacheKey,
    {
      lang: input.lang,
      onModelDownloadProgress: input.onModelDownloadProgress,
      shouldStart: input.shouldStart,
    },
  );
  return { alignments };
}

export async function runPdfLayoutFromPdfBuffer(input: {
  documentId: string;
  pdfBytes: ArrayBuffer;
  onPageStarted?: (input: {
    pageNumber: number;
    totalPages: number;
  }) => void | Promise<void>;
  onPageParsed?: (input: {
    pageNumber: number;
    totalPages: number;
    pageMs: number;
  }) => void | Promise<void>;
  onModelDownloadProgress?: ModelDownloadProgressHandler;
}) {
  const parsed = await parsePdf({
    documentId: input.documentId,
    pdfBytes: input.pdfBytes,
    onPageStarted: input.onPageStarted,
    onPageParsed: input.onPageParsed,
    onModelDownloadProgress: input.onModelDownloadProgress,
  });
  return { parsed };
}
