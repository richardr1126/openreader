import {
  createAudiobookChapter,
  getAudiobookStatus,
  withRetry,
} from '@/lib/client/api/audiobooks';
import type {
  AudiobookGenerationSettings,
  TTSRequestHeaders,
  TTSRetryOptions,
} from '@/types/client';
import type {
  TTSAudiobookChapter,
  TTSAudiobookFormat,
} from '@/types/tts';
import { normalizeTextForTts } from '@/lib/shared/nlp';

export interface PreparedAudiobookChapter {
  index: number;
  title: string;
  text: string;
}

export interface AudiobookSourceAdapter {
  prepareChapters: () => Promise<PreparedAudiobookChapter[]>;
  prepareChapter: (chapterIndex: number) => Promise<PreparedAudiobookChapter>;
  noContentMessage: string;
  noAudioGeneratedMessage: string;
}

interface RunAudiobookGenerationOptions {
  adapter: AudiobookSourceAdapter;
  apiKey: string;
  baseUrl: string;
  defaultProvider: string;
  onProgress: (progress: number) => void;
  signal?: AbortSignal;
  onChapterComplete?: (chapter: TTSAudiobookChapter) => void;
  providedBookId?: string;
  format?: TTSAudiobookFormat;
  settings?: AudiobookGenerationSettings;
  retryOptions?: TTSRetryOptions;
}

interface RegenerateAudiobookChapterOptions {
  adapter: AudiobookSourceAdapter;
  chapterIndex: number;
  bookId: string;
  format: TTSAudiobookFormat;
  signal: AbortSignal;
  apiKey: string;
  baseUrl: string;
  defaultProvider: string;
  settings?: AudiobookGenerationSettings;
  retryOptions?: TTSRetryOptions;
}

interface ResolvedAudiobookRequestSettings {
  effectiveProviderRef: string;
  effectiveFormat: TTSAudiobookFormat;
}

function resolveAudiobookRequestSettings(
  settings: AudiobookGenerationSettings | undefined,
  defaultProvider: string,
  format: TTSAudiobookFormat,
): ResolvedAudiobookRequestSettings {
  return {
    effectiveProviderRef: settings?.providerRef ?? defaultProvider,
    effectiveFormat: settings?.format ?? format,
  };
}

function buildAudiobookRequestHeaders(
  apiKey: string,
  baseUrl: string,
  effectiveProvider: string,
): TTSRequestHeaders {
  return {
    'Content-Type': 'application/json',
    'x-openai-key': apiKey,
    'x-openai-base-url': baseUrl,
    'x-tts-provider': effectiveProvider,
  };
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'));
}

function createAudiobookAbortError(): Error {
  const error = new Error('Audiobook generation cancelled');
  error.name = 'AbortError';
  return error;
}

export async function runAudiobookGeneration({
  adapter,
  apiKey,
  baseUrl,
  defaultProvider,
  onProgress,
  signal,
  onChapterComplete,
  providedBookId = '',
  format = 'mp3',
  settings,
  retryOptions = {
    maxRetries: 2,
    initialDelay: 300,
    maxDelay: 300,
  },
}: RunAudiobookGenerationOptions): Promise<string> {
  const chapters = (await adapter.prepareChapters()).map((chapter) => ({
    ...chapter,
    text: normalizeTextForTts(chapter.text, { language: settings?.language }),
  }));
  const totalLength = chapters.reduce((sum, chapter) => sum + chapter.text.trim().length, 0);
  if (totalLength === 0) {
    throw new Error(adapter.noContentMessage);
  }

  const { effectiveProviderRef, effectiveFormat } = resolveAudiobookRequestSettings(settings, defaultProvider, format);
  const reqHeaders = buildAudiobookRequestHeaders(apiKey, baseUrl, effectiveProviderRef);
  let processedLength = 0;
  let bookId = providedBookId;

  const existingIndices = new Set<number>();
  if (bookId) {
    try {
      const existingData = await getAudiobookStatus(bookId);
      if (existingData.chapters && existingData.chapters.length > 0) {
        for (const chapter of existingData.chapters) {
          if (chapter.status === 'completed') {
            existingIndices.add(chapter.index);
          }
        }
      }
    } catch (error) {
      console.error('Error checking existing chapters:', error);
    }
  }

  for (const chapter of chapters) {
    if (signal?.aborted) {
      throw createAudiobookAbortError();
    }

    const trimmedText = chapter.text.trim();
    if (!trimmedText) {
      continue;
    }

    if (existingIndices.has(chapter.index)) {
      processedLength += trimmedText.length;
      onProgress((processedLength / totalLength) * 100);
      continue;
    }

    try {
      const createdChapter = await withRetry(
        async () => {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          return createAudiobookChapter({
            chapterTitle: chapter.title,
            text: trimmedText,
            bookId,
            format: effectiveFormat,
            chapterIndex: chapter.index,
            settings,
          }, reqHeaders, signal);
        },
        retryOptions,
      );

      if (signal?.aborted) {
        throw createAudiobookAbortError();
      }

      if (!bookId) {
        if (createdChapter.bookId) {
          bookId = createdChapter.bookId;
        } else {
          throw new Error('Created chapter is missing bookId');
        }
      }

      onChapterComplete?.(createdChapter);
      processedLength += trimmedText.length;
      onProgress((processedLength / totalLength) * 100);
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw createAudiobookAbortError();
      }

      console.error('Error processing chapter:', error);
      onChapterComplete?.({
        index: chapter.index,
        title: chapter.title,
        status: 'error',
        bookId,
        format: effectiveFormat,
      });
      processedLength += trimmedText.length;
      onProgress((processedLength / totalLength) * 100);
    }
  }

  if (!bookId) {
    throw new Error(adapter.noAudioGeneratedMessage);
  }

  return bookId;
}

export async function regenerateAudiobookChapter({
  adapter,
  chapterIndex,
  bookId,
  format,
  signal,
  apiKey,
  baseUrl,
  defaultProvider,
  settings,
  retryOptions = {
    maxRetries: 2,
    initialDelay: 300,
    maxDelay: 300,
  },
}: RegenerateAudiobookChapterOptions): Promise<TTSAudiobookChapter> {
  const chapter = await adapter.prepareChapter(chapterIndex);
  const trimmedText = normalizeTextForTts(chapter.text, { language: settings?.language }).trim();
  if (!trimmedText) {
    throw new Error(adapter.noContentMessage);
  }

  const { effectiveProviderRef, effectiveFormat } = resolveAudiobookRequestSettings(settings, defaultProvider, format);
  const reqHeaders = buildAudiobookRequestHeaders(apiKey, baseUrl, effectiveProviderRef);

  return withRetry(
    async () => {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      return createAudiobookChapter({
        chapterTitle: chapter.title,
        text: trimmedText,
        bookId,
        format: effectiveFormat,
        chapterIndex,
        settings,
      }, reqHeaders, signal);
    },
    retryOptions,
  );
}
