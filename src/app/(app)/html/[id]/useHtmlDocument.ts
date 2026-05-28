'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { getDocumentMetadata } from '@/lib/client/api/documents';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { parseHtmlBlocks, type HtmlBlock } from '@/lib/client/html/blocks';
import { createHtmlAudiobookSourceAdapter } from '@/lib/client/audiobooks/adapters/html';
import { regenerateAudiobookChapter, runAudiobookGeneration } from '@/lib/client/audiobooks/pipeline';
import type {
  AudiobookGenerationSettings,
  TTSRetryOptions,
} from '@/types/client';
import type {
  TTSAudiobookChapter,
  TTSAudiobookFormat,
} from '@/types/tts';

export interface HtmlDocumentState {
  currDocData: string | undefined;
  currDocName: string | undefined;
  currDocText: string | undefined;
  blocks: HtmlBlock[];
  isTxt: boolean;
  setCurrentDocument: (id: string) => Promise<void>;
  clearCurrDoc: () => void;
  createFullAudioBook: (
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    onChapterComplete?: (chapter: TTSAudiobookChapter) => void,
    providedBookId?: string,
    format?: TTSAudiobookFormat,
    settings?: AudiobookGenerationSettings,
    retryOptions?: TTSRetryOptions,
  ) => Promise<string>;
  regenerateChapter: (
    chapterIndex: number,
    bookId: string,
    format: TTSAudiobookFormat,
    signal: AbortSignal,
    settings?: AudiobookGenerationSettings,
    retryOptions?: TTSRetryOptions,
  ) => Promise<TTSAudiobookChapter>;
}

function isTxtName(name: string | undefined | null): boolean {
  return !!name && name.toLowerCase().endsWith('.txt');
}

/**
 * Concatenate every block's plain text into one TTS source. We treat the
 * entire HTML/TXT/MD document as a single "page" with a flat sequence of
 * segments (sentence indices), so playback advances naturally through the
 * doc without any per-block locator bookkeeping.
 */
function buildFullDocumentText(blocks: HtmlBlock[]): string {
  return blocks
    .map((b) => b.plainText)
    .filter((t) => t && t.trim())
    .join('\n\n');
}

export function useHtmlDocument(): HtmlDocumentState {
  const { setText: setTTSText, stop, setIsEPUB } = useTTS();
  const {
    apiKey,
    baseUrl,
    providerRef,
    ttsSegmentMaxBlockLength,
  } = useConfig();

  const [currDocData, setCurrDocData] = useState<string>();
  const [currDocName, setCurrDocName] = useState<string>();

  const isTxt = useMemo(() => isTxtName(currDocName), [currDocName]);
  const blocks = useMemo(
    () => (currDocData !== undefined ? parseHtmlBlocks(currDocData, isTxt) : []),
    [currDocData, isTxt],
  );

  const currDocText = useMemo(() => buildFullDocumentText(blocks), [blocks]);

  // HTML reader is not an EPUB reader.
  useEffect(() => {
    setIsEPUB(false);
  }, [setIsEPUB]);

  // Feed the entire document into TTS once it's parsed. The TTS context owns
  // sentence splitting + sequential advancement from there.
  const lastFedDocRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currDocText) return;
    const key = `${currDocData ?? ''}::${currDocText.length}`;
    if (lastFedDocRef.current === key) return;
    lastFedDocRef.current = key;
    setTTSText(currDocText);
  }, [currDocText, currDocData, setTTSText]);

  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    lastFedDocRef.current = null;
    stop();
  }, [stop]);

  const setCurrentDocument = useCallback(async (id: string): Promise<void> => {
    try {
      const meta = await getDocumentMetadata(id);
      if (!meta) {
        console.error('Document not found on server');
        return;
      }

      const doc = await ensureCachedDocument(meta);
      if (doc.type !== 'html') {
        console.error('Document is not an HTML/TXT/MD document');
        return;
      }

      setCurrDocName(doc.name);
      setCurrDocData(doc.data);
    } catch (error) {
      console.error('Failed to get HTML document:', error);
      clearCurrDoc();
    }
  }, [clearCurrDoc]);

  const audiobookAdapter = useMemo(
    () =>
      createHtmlAudiobookSourceAdapter({
        blocks,
        isTxt,
        maxBlockLength: ttsSegmentMaxBlockLength,
      }),
    [blocks, isTxt, ttsSegmentMaxBlockLength],
  );

  const createFullAudioBook = useCallback(
    async (
      onProgress: (progress: number) => void,
      signal?: AbortSignal,
      onChapterComplete?: (chapter: TTSAudiobookChapter) => void,
      providedBookId?: string,
      format: TTSAudiobookFormat = 'mp3',
      settings?: AudiobookGenerationSettings,
      retryOptions?: TTSRetryOptions,
    ): Promise<string> => {
      try {
        return await runAudiobookGeneration({
          adapter: audiobookAdapter,
          apiKey,
          baseUrl,
          defaultProvider: providerRef,
          onProgress,
          signal,
          onChapterComplete,
          providedBookId,
          format,
          settings,
          retryOptions,
        });
      } catch (error) {
        console.error('Error creating audiobook:', error);
        throw error;
      }
    },
    [audiobookAdapter, apiKey, baseUrl, providerRef],
  );

  const regenerateChapter = useCallback(
    async (
      chapterIndex: number,
      bookId: string,
      format: TTSAudiobookFormat,
      signal: AbortSignal,
      settings?: AudiobookGenerationSettings,
      retryOptions?: TTSRetryOptions,
    ): Promise<TTSAudiobookChapter> => {
      try {
        return await regenerateAudiobookChapter({
          adapter: audiobookAdapter,
          chapterIndex,
          bookId,
          format,
          signal,
          apiKey,
          baseUrl,
          defaultProvider: providerRef,
          settings,
          retryOptions,
        });
      } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))) {
          throw new Error('Chapter regeneration cancelled');
        }
        console.error('Error regenerating chapter:', error);
        throw error;
      }
    },
    [audiobookAdapter, apiKey, baseUrl, providerRef],
  );

  return useMemo(
    () => ({
      currDocData,
      currDocName,
      currDocText,
      blocks,
      isTxt,
      setCurrentDocument,
      clearCurrDoc,
      createFullAudioBook,
      regenerateChapter,
    }),
    [
      currDocData,
      currDocName,
      currDocText,
      blocks,
      isTxt,
      setCurrentDocument,
      clearCurrDoc,
      createFullAudioBook,
      regenerateChapter,
    ],
  );
}
