import { ensureWhisperModel } from './whisper/model';
import { alignAudioWithText } from './whisper/align';
import { ensureModel as ensurePdfLayoutModel } from './pdf/model';
import { parsePdf, type ParsePdfInput } from './pdf/parse';
import type { ModelDownloadProgressHandler } from './model-download';

export async function ensureComputeModels(): Promise<void> {
  await Promise.all([
    ensureWhisperModel({ variant: 'tiny-english' }),
    ensurePdfLayoutModel(),
  ]);
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

export async function runPdfLayoutFromPdfBuffer(input: ParsePdfInput) {
  const parsed = await parsePdf(input);
  return { parsed };
}
