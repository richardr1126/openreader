import { ensureWhisperModel } from './whisper/model';
import { alignAudioWithText } from './whisper/align';
import { ensureModel as ensurePdfLayoutModel } from './pdf/model';
import { parsePdf } from './pdf/parse';

export async function ensureComputeModels(): Promise<void> {
  await Promise.all([ensureWhisperModel(), ensurePdfLayoutModel()]);
}

export async function runWhisperAlignmentFromAudioBuffer(input: {
  audioBuffer: ArrayBuffer;
  text: string;
  cacheKey?: string;
  lang?: string;
}) {
  const alignments = await alignAudioWithText(
    input.audioBuffer,
    input.text,
    input.cacheKey,
    { lang: input.lang },
  );
  return { alignments };
}

export async function runPdfLayoutFromPdfBuffer(input: {
  documentId: string;
  pdfBytes: ArrayBuffer;
  onPageParsed?: (input: {
    pageNumber: number;
    totalPages: number;
    pageMs: number;
  }) => void | Promise<void>;
}) {
  const parsed = await parsePdf({
    documentId: input.documentId,
    pdfBytes: input.pdfBytes,
    onPageParsed: input.onPageParsed,
  });
  return { parsed };
}
