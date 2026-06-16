'use client';

import { useCallback, useMemo, type RefObject } from 'react';
import type { Book, NavItem } from 'epubjs';
import type { SpineItem } from 'epubjs/types/section';

import { createEpubAudiobookSourceAdapter } from '@/lib/client/audiobooks/adapters/epub';
import { regenerateAudiobookChapter, runAudiobookGeneration } from '@/lib/client/audiobooks/pipeline';
import type { AudiobookGenerationSettings } from '@/types/client';
import type { TTSAudiobookChapter, TTSAudiobookFormat } from '@/types/tts';

type LoadedSection = {
  document?: Document;
};

export function resolveLoadedSpineSectionDocument(
  loaded: unknown,
  section: LoadedSection,
): Document | null {
  if (!loaded) return null;
  if (typeof Document !== 'undefined' && loaded instanceof Document) {
    return loaded;
  }
  const element = loaded as Element;
  if (element?.ownerDocument) {
    return element.ownerDocument;
  }
  return section.document ?? null;
}

export function filterNonEmptySpineTextEntries<T extends { text: string }>(entries: T[]): T[] {
  return entries.filter((entry) => entry.text.trim() !== '');
}

type UseEpubAudiobookParams = {
  bookRef: RefObject<Book | null>;
  tocRef: RefObject<NavItem[]>;
  providerRef: string;
};

type UseEpubAudiobookResult = {
  createFullAudioBook: (
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    onChapterComplete?: (chapter: TTSAudiobookChapter) => void,
    providedBookId?: string,
    format?: TTSAudiobookFormat,
    settings?: AudiobookGenerationSettings
  ) => Promise<string>;
  regenerateChapter: (
    chapterIndex: number,
    bookId: string,
    format: TTSAudiobookFormat,
    signal: AbortSignal,
    settings?: AudiobookGenerationSettings
  ) => Promise<TTSAudiobookChapter>;
};

export function useEPUBAudiobook({
  bookRef,
  tocRef,
  providerRef,
}: UseEpubAudiobookParams): UseEpubAudiobookResult {
  const loadSpineSection = useCallback(async (href: string) => {
    const book = bookRef.current;
    if (!book?.isOpen) return null;
    const section = book.spine.get(href);
    if (!section) return null;

    const loaded = await Promise.resolve(section.load(book.load.bind(book)));
    const doc = resolveLoadedSpineSectionDocument(loaded, section as LoadedSection);

    if (!doc) return null;
    return { section, doc };
  }, [bookRef]);

  const extractBookText = useCallback(async (): Promise<Array<{ text: string; href: string }>> => {
    try {
      if (!bookRef.current || !bookRef.current.isOpen) return [{ text: '', href: '' }];

      const book = bookRef.current;
      const spine = book.spine;
      const promises: Promise<{ text: string; href: string }>[] = [];

      spine.each((item: SpineItem) => {
        const url = item.href || '';
        if (!url) return;
        const promise = loadSpineSection(url)
          .then((loaded) => {
            if (!loaded?.doc) return { text: '', href: url };
            const text = loaded.doc.body?.textContent || '';
            return { text, href: url };
          })
          .catch((err) => {
            console.error(`Error loading section ${url}:`, err);
            return { text: '', href: url };
          })
          .finally(() => {
            const section = book.spine.get(url);
            section?.unload?.();
          });

        promises.push(promise);
      });

      const textArray = await Promise.all(promises);
      return filterNonEmptySpineTextEntries(textArray);
    } catch (error) {
      console.error('Error extracting EPUB text:', error);
      return [{ text: '', href: '' }];
    }
  }, [bookRef, loadSpineSection]);

  const audiobookAdapter = useMemo(() => createEpubAudiobookSourceAdapter({
    extractBookText,
    getTocItems: () => tocRef.current || [],
  }), [extractBookText, tocRef]);

  const createFullAudioBook = useCallback(async (
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    onChapterComplete?: (chapter: TTSAudiobookChapter) => void,
    providedBookId?: string,
    format: TTSAudiobookFormat = 'mp3',
    settings?: AudiobookGenerationSettings
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
      });
    } catch (error) {
      console.error('Error creating audiobook:', error);
      throw error;
    }
  }, [audiobookAdapter, providerRef]);

  const regenerateChapter = useCallback(async (
    chapterIndex: number,
    bookId: string,
    format: TTSAudiobookFormat,
    signal: AbortSignal,
    settings?: AudiobookGenerationSettings
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
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))) {
        throw new Error('Chapter regeneration cancelled');
      }
      console.error('Error regenerating chapter:', error);
      throw error;
    }
  }, [audiobookAdapter, providerRef]);

  return {
    createFullAudioBook,
    regenerateChapter,
  };
}
