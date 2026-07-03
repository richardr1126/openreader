'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { parseHtmlBlocks, type HtmlBlock } from '@/lib/client/html/blocks';
import type { CanonicalTtsSourceUnit } from '@/lib/shared/tts-segment-plan';
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
import type { BaseDocument } from '@/types/documents';

export interface HtmlDocumentState {
  currDocData: string | undefined;
  currDocName: string | undefined;
  currDocText: string | undefined;
  isPlaybackReady: boolean;
  blocks: HtmlBlock[];
  isTxt: boolean;
  setCurrentDocument: (metadata: BaseDocument) => Promise<void>;
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
 * Concatenate every block's plain text into one TTS source string. Kept for the
 * playback-ready / change-detection key and blank-doc checks.
 */
function buildFullDocumentText(blocks: HtmlBlock[]): string {
  return blocks
    .map((b) => b.plainText)
    .filter((t) => t && t.trim())
    .join('\n\n');
}

/**
 * Feed one TTS source unit per top-level block (heading, paragraph, list, ...)
 * so segment planning respects block boundaries: each block becomes its own
 * segment(s) with an `{ readerType: 'html', location: anchorId }` locator for
 * scoped highlighting. Previously the whole document was fed as a single
 * concatenated string, which collapsed the `\n\n` block separators during
 * audio-text normalization and let the block packer merge unrelated paragraphs
 * (and headings) into one run-on segment — the cause of "skipped" paragraphs.
 */
function buildBlockSourceUnits(blocks: HtmlBlock[]): CanonicalTtsSourceUnit[] {
  return blocks
    .filter((b) => b.plainText && b.plainText.trim())
    .map((b) => ({
      sourceKey: b.anchorId,
      text: b.plainText,
      locator: { readerType: 'html' as const, location: b.anchorId },
    }));
}

export function useHtmlDocument(): HtmlDocumentState {
  const { setText: setTTSText, stop, setIsEPUB } = useTTS();
  const {
    providerRef,
    ttsSegmentMaxBlockLength,
  } = useConfig();

  const [currDocData, setCurrDocData] = useState<string>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [isPlaybackReady, setIsPlaybackReady] = useState(false);

  const isTxt = useMemo(() => isTxtName(currDocName), [currDocName]);
  const blocks = useMemo(
    () => (currDocData !== undefined ? parseHtmlBlocks(currDocData, isTxt) : []),
    [currDocData, isTxt],
  );

  const currDocText = useMemo(() => buildFullDocumentText(blocks), [blocks]);
  const blockSourceUnits = useMemo(() => buildBlockSourceUnits(blocks), [blocks]);

  // HTML reader is not an EPUB reader.
  useEffect(() => {
    setIsEPUB(false);
  }, [setIsEPUB]);

  // Feed the entire document into TTS once it's parsed. The TTS context owns
  // sentence splitting + sequential advancement from there.
  const lastFedDocRef = useRef<string | null>(null);
  useEffect(() => {
    if (currDocData === undefined) {
      lastFedDocRef.current = null;
      setTTSText('');
      setIsPlaybackReady(false);
      return;
    }
    if (!currDocText) {
      lastFedDocRef.current = null;
      setTTSText('');
      setIsPlaybackReady(true);
      return;
    }
    const key = `${currDocName ?? ''}::${currDocData ?? ''}::${currDocText.length}`;
    if (lastFedDocRef.current === key) {
      setIsPlaybackReady(true);
      return;
    }
    setIsPlaybackReady(false);
    lastFedDocRef.current = key;
    // Feed one source unit per block so segment planning keeps block boundaries.
    setTTSText(currDocText, blockSourceUnits.length > 0 ? { sourceUnits: blockSourceUnits } : undefined);
    setIsPlaybackReady(true);
  }, [currDocName, currDocText, currDocData, blockSourceUnits, blocks.length, setTTSText]);

  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    setIsPlaybackReady(false);
    lastFedDocRef.current = null;
    setTTSText('');
    stop();
  }, [setTTSText, stop]);

  const setCurrentDocument = useCallback(async (meta: BaseDocument): Promise<void> => {
    try {
      setIsPlaybackReady(false);
      lastFedDocRef.current = null;
      setTTSText('');
      const doc = await ensureCachedDocument(meta);
      if (doc.type !== 'html') {
        // Throw so the catch handler clears stale reader state instead of
        // leaving the previous document visible after a mismatched navigation.
        throw new Error('Document is not an HTML/TXT/MD document');
      }

      setCurrDocName(doc.name);
      setCurrDocData(doc.data);
    } catch (error) {
      console.error('Failed to get HTML document:', error);
      clearCurrDoc();
      throw error;
    }
  }, [clearCurrDoc, setTTSText]);

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
    [audiobookAdapter, providerRef],
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
    [audiobookAdapter, providerRef],
  );

  return useMemo(
    () => ({
      currDocData,
      currDocName,
      currDocText,
      isPlaybackReady,
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
      isPlaybackReady,
      blocks,
      isTxt,
      setCurrentDocument,
      clearCurrDoc,
      createFullAudioBook,
      regenerateChapter,
    ],
  );
}
