'use client';

import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useCallback,
  useMemo,
  useRef,
  RefObject,
  useEffect
} from 'react';

import type { NavItem } from 'epubjs';
import type { SpineItem } from 'epubjs/types/section';
import type { Book, Rendition } from 'epubjs';

import { setLastDocumentLocation } from '@/lib/client/dexie';
import { scheduleDocumentProgressSync } from '@/lib/client/api/user-state';
import { getDocumentMetadata } from '@/lib/client/api/documents';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { useTTS } from '@/contexts/TTSContext';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { createRangeCfi } from '@/lib/client/epub';
import { useParams } from 'next/navigation';
import { useConfig } from './ConfigContext';
import { withRetry, getAudiobookStatus, generateTTS, createAudiobookChapter } from '@/lib/client/api/audiobooks';
import { CmpStr } from 'cmpstr';
import type {
  TTSSentenceAlignment,
  TTSAudiobookFormat,
  TTSAudiobookChapter,
} from '@/types/tts';
import type {
  TTSRequestHeaders,
  TTSRequestPayload,
  TTSRetryOptions,
  AudiobookGenerationSettings,
} from '@/types/client';

interface EPUBContextType {
  currDocData: ArrayBuffer | undefined;
  currDocName: string | undefined;
  currDocPages: number | undefined;
  currDocPage: number | string;
  currDocText: string | undefined;
  setCurrentDocument: (id: string) => Promise<void>;
  clearCurrDoc: () => void;
  extractPageText: (book: Book, rendition: Rendition, shouldPause?: boolean) => Promise<string>;
  createFullAudioBook: (
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    onChapterComplete?: (chapter: TTSAudiobookChapter) => void,
    bookId?: string,
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
  bookRef: RefObject<Book | null>;
  renditionRef: RefObject<Rendition | undefined>;
  tocRef: RefObject<NavItem[]>;
  locationRef: RefObject<string | number>;
  handleLocationChanged: (location: string | number) => void;
  setRendition: (rendition: Rendition) => void;
  isAudioCombining: boolean;
  highlightPattern: (text: string) => void;
  clearHighlights: () => void;
  highlightWordIndex: (
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    sentence: string | null | undefined
  ) => void;
  clearWordHighlights: () => void;
}

const EPUBContext = createContext<EPUBContextType | undefined>(undefined);

const EPUB_CONTINUATION_CHARS = 5000;

const cmp = CmpStr.create().setMetric('dice').setFlags('itw');

const normalizeWordForMatch = (text: string): string =>
  text
    .trim()
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .toLowerCase();

const stepToNextNode = (node: Node | null, root: Node): Node | null => {
  if (!node) return null;
  if (node.firstChild) {
    return node.firstChild;
  }

  let current: Node | null = node;
  while (current) {
    if (current === root) {
      return null;
    }
    if (current.nextSibling) {
      return current.nextSibling;
    }
    current = current.parentNode;
  }

  return null;
};

const getNextTextNode = (node: Node | null, root: Node): Text | null => {
  let next = stepToNextNode(node, root);
  while (next) {
    if (next.nodeType === Node.TEXT_NODE) {
      return next as Text;
    }
    next = stepToNextNode(next, root);
  }
  return null;
};

const collectContinuationFromRange = (range: Range | null | undefined, limit = EPUB_CONTINUATION_CHARS): string => {
  if (typeof window === 'undefined' || !range) {
    return '';
  }

  const root = range.commonAncestorContainer;
  if (!root) {
    return '';
  }

  const parts: string[] = [];
  let remaining = limit;

  const appendFromTextNode = (textNode: Text, offset: number) => {
    if (remaining <= 0) return;
    const textContent = textNode.textContent || '';
    if (offset >= textContent.length) return;
    const slice = textContent.slice(offset, offset + remaining);
    if (slice) {
      parts.push(slice);
      remaining -= slice.length;
    }
  };

  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    appendFromTextNode(range.endContainer as Text, range.endOffset);
    let nextNode = getNextTextNode(range.endContainer, root);
    while (nextNode && remaining > 0) {
      appendFromTextNode(nextNode, 0);
      nextNode = getNextTextNode(nextNode, root);
    }
  } else {
    let nextNode = getNextTextNode(range.endContainer, root);
    while (nextNode && remaining > 0) {
      appendFromTextNode(nextNode, 0);
      nextNode = getNextTextNode(nextNode, root);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

/**
 * Provider component for EPUB functionality
 * Manages the state and operations for EPUB document handling
 * @param {Object} props - Component props
 * @param {ReactNode} props.children - Child components to be wrapped by the provider
 */
export function EPUBProvider({ children }: { children: ReactNode }) {
  const { setText: setTTSText, currDocPage, currDocPages, setCurrDocPages, stop, skipToLocation, setIsEPUB } = useTTS();
  const { authEnabled } = useAuthConfig();
  const { id } = useParams();
  // Configuration context to get TTS settings
  const {
    apiKey,
    baseUrl,
    voiceSpeed,
    voice,
    ttsProvider,
    ttsModel,
    ttsInstructions,
    smartSentenceSplitting,
    epubHighlightEnabled,
  } = useConfig();
  // Current document state
  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();
  const [isAudioCombining] = useState(false);

  // Add new refs
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | undefined>(undefined);
  const tocRef = useRef<NavItem[]>([]);
  const locationRef = useRef<string | number>(currDocPage);
  const isEPUBSetOnce = useRef(false);
  // Should pause ref
  const shouldPauseRef = useRef(true);
  // Track current highlight CFI for removal
  const currentHighlightCfi = useRef<string | null>(null);
  const currentWordHighlightCfi = useRef<string | null>(null);

  /**
   * Clears all current document state and stops any active TTS
   */
  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    setCurrDocText(undefined);
    setCurrDocPages(undefined);
    isEPUBSetOnce.current = false;
    bookRef.current = null;
    renditionRef.current = undefined;
    locationRef.current = 1;
    tocRef.current = [];
    stop();
  }, [setCurrDocPages, stop]);

  /**
   * Sets the current document based on its ID by fetching from IndexedDB
   * @param {string} id - The unique identifier of the document
   * @throws {Error} When document data is empty or retrieval fails
   */
  const setCurrentDocument = useCallback(async (id: string): Promise<void> => {
    try {
      const meta = await getDocumentMetadata(id);
      if (!meta) {
        clearCurrDoc();
        console.error('Document not found on server');
        return;
      }

      const doc = await ensureCachedDocument(meta);
      if (doc.type !== 'epub') {
        clearCurrDoc();
        console.error('Document is not an EPUB');
        return;
      }

      if (doc.data.byteLength === 0) {
        console.error('Retrieved ArrayBuffer is empty');
        throw new Error('Empty document data');
      }

      setCurrDocName(doc.name);
      setCurrDocData(doc.data); // Store ArrayBuffer directly
    } catch (error) {
      console.error('Failed to get EPUB document:', error);
      clearCurrDoc(); // Clean up on error
    }
  }, [clearCurrDoc]);

  /**
   * Extracts text content from the current EPUB page/location
   * @param {Book} book - The EPUB.js Book instance
   * @param {Rendition} rendition - The EPUB.js Rendition instance
   * @param {boolean} shouldPause - Whether to pause TTS
   * @returns {Promise<string>} The extracted text content
   */
  const extractPageText = useCallback(async (book: Book, rendition: Rendition, shouldPause = false): Promise<string> => {
    try {
      const { start, end } = rendition?.location;
      if (!start?.cfi || !end?.cfi || !book || !book.isOpen || !rendition) return '';

      const rangeCfi = createRangeCfi(start.cfi, end.cfi);

      const range = await book.getRange(rangeCfi);
      if (!range) {
        console.warn('Failed to get range from CFI:', rangeCfi);
        return '';
      }
      const textContent = range.toString().trim();
      const continuationPreview = collectContinuationFromRange(range);

      if (smartSentenceSplitting) {
        setTTSText(textContent, {
          shouldPause,
          location: start.cfi,
          nextLocation: end.cfi,
          nextText: continuationPreview
        });
      } else {
        // When smart splitting is disabled, behave like the original implementation:
        // send only the current page/location text without any continuation preview.
        setTTSText(textContent, {
          shouldPause,
          location: start.cfi,
        });
      }
      setCurrDocText(textContent);

      return textContent;
    } catch (error) {
      console.error('Error extracting EPUB text:', error);
      return '';
    }
  }, [setTTSText, smartSentenceSplitting]);

  /**
   * Extracts text content from the entire EPUB book
   * @returns {Promise<string[]>} Array of text content from each section
   */
  const extractBookText = useCallback(async (): Promise<Array<{ text: string; href: string }>> => {
    try {
      if (!bookRef.current || !bookRef.current.isOpen) return [{ text: '', href: '' }];

      const book = bookRef.current;
      const spine = book.spine;
      const promises: Promise<{ text: string; href: string }>[] = [];

      spine.each((item: SpineItem) => {
        const url = item.href || '';
        if (!url) return;
        //console.log('Extracting text from section:', item as SpineItem);

        const promise = book.load(url)
          .then((section) => (section as Document))
          .then((section) => ({
            text: section.body.textContent || '',
            href: url
          }))
          .catch((err) => {
            console.error(`Error loading section ${url}:`, err);
            return { text: '', href: url };
          });

        promises.push(promise);
      });

      const textArray = await Promise.all(promises);
      const filteredArray = textArray.filter(item => item.text.trim() !== '');
      console.log('Extracted entire EPUB text array:', filteredArray);
      return filteredArray;
    } catch (error) {
      console.error('Error extracting EPUB text:', error);
      return [{ text: '', href: '' }];
    }
  }, []);

  /**
   * Creates a complete audiobook by processing all text through NLP and TTS
   */
  const createFullAudioBook = useCallback(async (
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    onChapterComplete?: (chapter: TTSAudiobookChapter) => void,
    providedBookId?: string,
    format: TTSAudiobookFormat = 'mp3',
    settings?: AudiobookGenerationSettings
  ): Promise<string> => {
    try {
      const sections = await extractBookText();
      if (!sections.length) throw new Error('No text content found in book');

      const effectiveProvider = settings?.ttsProvider ?? ttsProvider;
      const effectiveModel = settings?.ttsModel ?? ttsModel;
      const effectiveVoice =
        settings?.voice ||
        voice ||
        (effectiveProvider === 'openai'
          ? 'alloy'
          : effectiveProvider === 'deepinfra'
            ? 'af_bella'
            : 'af_sarah');
      const effectiveNativeSpeed = settings?.nativeSpeed ?? voiceSpeed;
      const effectiveFormat = settings?.format ?? format;

      // Calculate total length for accurate progress tracking
      const totalLength = sections.reduce((sum, section) => sum + section.text.trim().length, 0);
      let processedLength = 0;
      let bookId: string = providedBookId || '';

      // Get TOC for chapter titles
      const chapters = tocRef.current || [];

      // If we have a bookId, check for existing chapters to determine which indices already exist
      const existingIndices = new Set<number>();
      if (bookId) {
        try {
          const existingData = await getAudiobookStatus(bookId);
          if (existingData.chapters && existingData.chapters.length > 0) {
            for (const ch of existingData.chapters) {
              existingIndices.add(ch.index);
            }
            // Log smallest missing index for visibility
            let nextMissing = 0;
            while (existingIndices.has(nextMissing)) nextMissing++;
            console.log(`Resuming; next missing chapter index is ${nextMissing}`);
          }
        } catch (error) {
          console.error('Error checking existing chapters:', error);
        }
      }

      // Create a map of section hrefs to their chapter titles
      const sectionTitleMap = new Map<string, string>();

      // First, loop through all chapters to create the mapping
      for (const chapter of chapters) {
        if (!chapter.href) continue;
        const chapterBaseHref = chapter.href.split('#')[0];
        const chapterTitle = chapter.label.trim();

        // For each chapter, find all matching sections
        for (const section of sections) {
          const sectionHref = section.href;
          const sectionBaseHref = sectionHref.split('#')[0];

          // If this section matches this chapter, map it
          if (sectionHref === chapter.href || sectionBaseHref === chapterBaseHref) {
            sectionTitleMap.set(sectionHref, chapterTitle);
          }
        }
      }

      // Process each section
      for (let i = 0; i < sections.length; i++) {
        // Check for abort at the start of iteration
        if (signal?.aborted) {
          console.log('Generation cancelled by user');
          if (bookId) {
            return bookId; // Return bookId with partial progress
          }
          throw new Error('Audiobook generation cancelled');
        }

        const section = sections[i];
        const trimmedText = section.text.trim();
        if (!trimmedText) continue;

        // Skip chapters that already exist on disk (supports non-contiguous indices)
        if (existingIndices.has(i)) {
          processedLength += trimmedText.length;
          onProgress((processedLength / totalLength) * 100);
          continue;
        }

        try {
          const reqHeaders: TTSRequestHeaders = {
            'Content-Type': 'application/json',
            'x-openai-key': apiKey,
            'x-openai-base-url': baseUrl,
            'x-tts-provider': effectiveProvider,
          };

          const reqBody: TTSRequestPayload = {
            text: trimmedText,
            voice: effectiveVoice,
            speed: effectiveNativeSpeed,
            format: 'mp3',
            model: effectiveModel,
            instructions: effectiveModel === 'gpt-4o-mini-tts' ? ttsInstructions : undefined
          };

          // Allow one narrow client retry for transient browser->/api/tts transport failures.
          // HTTP failures are not retried client-side.
          const retryOptions: TTSRetryOptions = {
            maxRetries: 2,
            initialDelay: 300,
            maxDelay: 300,
          };

          const audioBuffer = await withRetry(
            async () => {
              // Check for abort before starting TTS request
              if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
              }

              return await generateTTS(reqBody, reqHeaders, signal);
            },
            retryOptions
          );

          // Get the chapter title from our pre-computed map
          let chapterTitle = sectionTitleMap.get(section.href);

          // If no chapter title found, use index-based naming
          if (!chapterTitle) {
            chapterTitle = `Chapter ${i + 1}`;
          }

          // Check for abort before sending to server
          if (signal?.aborted) {
            console.log('Generation cancelled before saving chapter');
            if (bookId) {
              return bookId;
            }
            throw new Error('Audiobook generation cancelled');
          }

          // Send to server for conversion and storage
          const chapter = await createAudiobookChapter({
            chapterTitle,
            buffer: Array.from(new Uint8Array(audioBuffer)),
            bookId,
            format: effectiveFormat,
            chapterIndex: i,
            settings
          }, signal);

          if (!bookId) {
            bookId = chapter.bookId!;
          }

          // Notify about completed chapter
          if (onChapterComplete) {
            onChapterComplete(chapter);
          }

          processedLength += trimmedText.length;
          onProgress((processedLength / totalLength) * 100);

        } catch (error) {
          if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))) {
            console.log('TTS request aborted, returning partial progress');
            if (bookId) {
              return bookId; // Return with partial progress
            }
            throw new Error('Audiobook generation cancelled');
          }
          console.error('Error processing section:', error);

          // Notify about error
          if (onChapterComplete) {
            onChapterComplete({
              index: i,
              title: sectionTitleMap.get(section.href) || `Chapter ${i + 1}`,
              status: 'error',
              bookId,
              format: effectiveFormat
            });
          }
        }
      }

      if (!bookId) {
        throw new Error('No audio was generated from the book content');
      }

      return bookId;
    } catch (error) {
      console.error('Error creating audiobook:', error);
      throw error;
    }
  }, [extractBookText, apiKey, baseUrl, voice, voiceSpeed, ttsProvider, ttsModel, ttsInstructions]);

  /**
   * Regenerates a specific chapter of the audiobook
   */
  const regenerateChapter = useCallback(async (
    chapterIndex: number,
    bookId: string,
    format: TTSAudiobookFormat,
    signal: AbortSignal,
    settings?: AudiobookGenerationSettings
  ): Promise<TTSAudiobookChapter> => {
    try {
      const sections = await extractBookText();
      if (chapterIndex >= sections.length) {
        throw new Error('Invalid chapter index');
      }

      const effectiveProvider = settings?.ttsProvider ?? ttsProvider;
      const effectiveModel = settings?.ttsModel ?? ttsModel;
      const effectiveVoice =
        settings?.voice ||
        voice ||
        (effectiveProvider === 'openai'
          ? 'alloy'
          : effectiveProvider === 'deepinfra'
            ? 'af_bella'
            : 'af_sarah');
      const effectiveNativeSpeed = settings?.nativeSpeed ?? voiceSpeed;
      const effectiveFormat = settings?.format ?? format;

      const section = sections[chapterIndex];
      const trimmedText = section.text.trim();

      if (!trimmedText) {
        throw new Error('No text content found in chapter');
      }

      // Get TOC for chapter title
      const chapters = tocRef.current || [];
      const sectionTitleMap = new Map<string, string>();

      for (const chapter of chapters) {
        if (!chapter.href) continue;
        const chapterBaseHref = chapter.href.split('#')[0];
        const chapterTitle = chapter.label.trim();

        for (const sect of sections) {
          const sectionHref = sect.href;
          const sectionBaseHref = sectionHref.split('#')[0];

          if (sectionHref === chapter.href || sectionBaseHref === chapterBaseHref) {
            sectionTitleMap.set(sectionHref, chapterTitle);
          }
        }
      }

      const chapterTitle = sectionTitleMap.get(section.href) || `Chapter ${chapterIndex + 1}`;

      // Generate audio with retry logic
      const reqHeaders: TTSRequestHeaders = {
        'Content-Type': 'application/json',
        'x-openai-key': apiKey,
        'x-openai-base-url': baseUrl,
        'x-tts-provider': effectiveProvider,
      };

      const reqBody: TTSRequestPayload = {
        text: trimmedText,
        voice: effectiveVoice,
        speed: effectiveNativeSpeed,
        format: 'mp3',
        model: effectiveModel,
        instructions: effectiveModel === 'gpt-4o-mini-tts' ? ttsInstructions : undefined
      };

      // Allow one narrow client retry for transient browser->/api/tts transport failures.
      // HTTP failures are not retried client-side.
      const retryOptions: TTSRetryOptions = {
        maxRetries: 2,
        initialDelay: 300,
        maxDelay: 300,
      };

      const audioBuffer = await withRetry(
        async () => {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          return await generateTTS(reqBody, reqHeaders, signal);
        },
        retryOptions
      );

      if (signal?.aborted) {
        throw new Error('Chapter regeneration cancelled');
      }

      // Send to server for conversion and storage
      const chapter = await createAudiobookChapter({
        chapterTitle,
        buffer: Array.from(new Uint8Array(audioBuffer)),
        bookId,
        format: effectiveFormat,
        chapterIndex,
        settings
      }, signal);

      return chapter;

    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))) {
        throw new Error('Chapter regeneration cancelled');
      }
      console.error('Error regenerating chapter:', error);
      throw error;
    }
  }, [extractBookText, apiKey, baseUrl, voice, voiceSpeed, ttsProvider, ttsModel, ttsInstructions]);

  const setRendition = useCallback((rendition: Rendition) => {
    bookRef.current = rendition.book;
    renditionRef.current = rendition;
  }, []);

  const handleLocationChanged = useCallback((location: string | number) => {
    // Set the EPUB flag once the location changes
    if (!isEPUBSetOnce.current) {
      setIsEPUB(true);
      isEPUBSetOnce.current = true;

      renditionRef.current?.display(location.toString());
      return;
    }

    if (!bookRef.current?.isOpen || !renditionRef.current) return;

    // If the location is a CFI string that doesn't match the current rendered position,
    // navigate there and let the subsequent locationChanged callback handle text extraction.
    if (typeof location === 'string' && location !== 'next' && location !== 'prev' && renditionRef.current?.location) {
      const currentStartCfi = renditionRef.current.location?.start?.cfi;
      if (currentStartCfi && location !== currentStartCfi) {
        renditionRef.current.display(location);
        return;
      }
    }

    // Handle special 'next' and 'prev' cases
    if (location === 'next' && renditionRef.current) {
      shouldPauseRef.current = false;
      renditionRef.current.next();
      return;
    }
    if (location === 'prev' && renditionRef.current) {
      shouldPauseRef.current = false;
      renditionRef.current.prev();
      return;
    }

    // Save the location to IndexedDB if not initial
    if (id && locationRef.current !== 1) {
      console.log('Saving location:', location);
      setLastDocumentLocation(id as string, location.toString());
      if (authEnabled) {
        scheduleDocumentProgressSync({
          documentId: id as string,
          readerType: 'epub',
          location: location.toString(),
        });
      }
    }

    skipToLocation(location);

    locationRef.current = location;
    if (bookRef.current && renditionRef.current) {
      extractPageText(bookRef.current, renditionRef.current, shouldPauseRef.current);
      shouldPauseRef.current = true;
    }
  }, [id, skipToLocation, extractPageText, setIsEPUB, authEnabled]);

  const clearWordHighlights = useCallback(() => {
    if (!renditionRef.current) return;
    if (currentWordHighlightCfi.current) {
      renditionRef.current.annotations.remove(currentWordHighlightCfi.current, 'highlight');
      currentWordHighlightCfi.current = null;
    }
  }, []);

  const clearHighlights = useCallback(() => {
    if (renditionRef.current && currentHighlightCfi.current) {
      renditionRef.current.annotations.remove(currentHighlightCfi.current, 'highlight');
      currentHighlightCfi.current = null;
    }
    clearWordHighlights();
  }, [clearWordHighlights]);

  const highlightPattern = useCallback(async (text: string) => {
    if (!renditionRef.current) return;

    // Clear existing highlights first
    clearHighlights();

    if (!epubHighlightEnabled) return;

    if (!text || !text.trim()) return;

    try {
      const contents = renditionRef.current.getContents();
      const contentsArray = Array.isArray(contents) ? contents : [contents];
      for (const content of contentsArray) {
        const win = content.window;
        if (win && win.find) {
          // Reset selection to start of document to ensure full search
          const sel = win.getSelection();
          sel?.removeAllRanges();

          // Attempt to find the text
          // window.find(aString, aCaseSensitive, aBackwards, aWrapAround, aWholeWord, aSearchInFrames, aShowDialog);
          // Note: We search for the trimmed text.
          if (win.find(text.trim(), false, false, true, false, false, false)) {
            const range = sel?.getRangeAt(0);
            if (range) {
              const cfi = content.cfiFromRange(range);
              // Store CFI for removal
              currentHighlightCfi.current = cfi;
              renditionRef.current.annotations.add('highlight', cfi, {}, (e: MouseEvent) => {
                console.log('Highlight clicked', e);
              }, '', { fill: 'grey', 'fill-opacity': '0.4', 'mix-blend-mode': 'multiply' });

              // Clear the browser selection so it doesn't look like user selected text
              sel?.removeAllRanges();
              return; // Stop after first match
            }
          }
        }
      }
    } catch (error) {
      console.error('Error highlighting text:', error);
    }
  }, [clearHighlights, epubHighlightEnabled]);

  // Effect to clear highlights when disabled
  useEffect(() => {
    if (!epubHighlightEnabled) {
      clearHighlights();
    }
  }, [epubHighlightEnabled, clearHighlights]);

  const highlightWordIndex = useCallback((
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    sentence: string | null | undefined
  ) => {
    clearWordHighlights();

    if (!epubHighlightEnabled) return;
    if (!alignment) return;
    if (wordIndex === null || wordIndex === undefined || wordIndex < 0) return;

    const words = alignment.words || [];
    if (!words.length || wordIndex >= words.length) return;

    if (!renditionRef.current) return;
    if (!currentHighlightCfi.current) return;

    const cleanSentence =
      sentence && sentence.trim()
        ? sentence.trim().replace(/\s+/g, ' ')
        : null;
    if (!cleanSentence) return;

    const alignmentSentenceClean = alignment.sentence
      ? alignment.sentence.trim().replace(/\s+/g, ' ')
      : null;
    if (!alignmentSentenceClean || alignmentSentenceClean !== cleanSentence) {
      return;
    }

    const contents = renditionRef.current.getContents();
    const contentsArray = Array.isArray(contents) ? contents : [contents];

    for (const content of contentsArray) {
      let range: Range | null = null;
      try {
        range = content.range(currentHighlightCfi.current as string);
      } catch {
        range = null;
      }
      if (!range) continue;

      const root = range.commonAncestorContainer;
      if (!root) continue;

      const domTokens: Array<{
        node: Text;
        startOffset: number;
        endOffset: number;
        norm: string;
      }> = [];

      const addTokensFromNode = (textNode: Text, start: number, end: number) => {
        const full = textNode.textContent || '';
        const safeStart = Math.max(0, Math.min(start, full.length));
        const safeEnd = Math.max(safeStart, Math.min(end, full.length));
        if (safeEnd <= safeStart) return;

        const slice = full.slice(safeStart, safeEnd);
        const wordRegex = /\S+/g;
        let match: RegExpExecArray | null;
        while ((match = wordRegex.exec(slice)) !== null) {
          const raw = match[0];
          const norm = normalizeWordForMatch(raw);
          if (!norm) continue;
          const tokenStart = safeStart + match.index;
          const tokenEnd = tokenStart + raw.length;
          domTokens.push({
            node: textNode,
            startOffset: tokenStart,
            endOffset: tokenEnd,
            norm,
          });
        }
      };

      const nextTextNode = (node: Node | null): Text | null => {
        let next = getNextTextNode(node, root);
        while (next) {
          if (next.nodeType === Node.TEXT_NODE) {
            return next as Text;
          }
          next = getNextTextNode(next, root);
        }
        return null;
      };

      // Collect tokens within the sentence range
      if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
        addTokensFromNode(range.startContainer as Text, range.startOffset, range.endOffset);
      } else {
        let current: Text | null = null;

        if (range.startContainer.nodeType === Node.TEXT_NODE) {
          const startText = range.startContainer as Text;
          const isEnd = range.endContainer === startText && range.endContainer.nodeType === Node.TEXT_NODE;
          const endOffset = isEnd ? range.endOffset : (startText.textContent || '').length;
          addTokensFromNode(startText, range.startOffset, endOffset);
          if (isEnd) {
            current = null;
          } else {
            current = nextTextNode(startText);
          }
        } else {
          current = nextTextNode(range.startContainer);
        }

        while (current) {
          if (range.endContainer.nodeType === Node.TEXT_NODE && current === range.endContainer) {
            addTokensFromNode(current, 0, range.endOffset);
            break;
          } else {
            addTokensFromNode(current, 0, (current.textContent || '').length);
          }
          current = nextTextNode(current);
        }
      }

      if (!domTokens.length) {
        return;
      }

      const domFiltered: Array<{ tokenIndex: number; norm: string }> = [];
      for (let i = 0; i < domTokens.length; i++) {
        const norm = domTokens[i].norm;
        if (!norm) continue;
        domFiltered.push({ tokenIndex: i, norm });
      }

      const ttsFiltered: Array<{ wordIndex: number; norm: string }> = [];
      for (let i = 0; i < words.length; i++) {
        const norm = normalizeWordForMatch(words[i].text);
        if (!norm) continue;
        ttsFiltered.push({ wordIndex: i, norm });
      }

      const wordToToken = new Array<number>(words.length).fill(-1);
      const m = domFiltered.length;
      const n = ttsFiltered.length;

      if (m && n) {
        const dp: number[][] = Array.from({ length: m + 1 }, () =>
          new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY)
        );
        const bt: number[][] = Array.from({ length: m + 1 }, () =>
          new Array<number>(n + 1).fill(0)
        ); // 0=diag,1=up,2=left

        dp[0][0] = 0;
        const GAP_COST = 0.7;

        for (let i = 0; i <= m; i++) {
          for (let j = 0; j <= n; j++) {
            if (i > 0 && j > 0) {
              const a = domFiltered[i - 1].norm;
              const b = ttsFiltered[j - 1].norm;
              const sim = cmp.compare(a, b);
              const subCost = 1 - sim;
              const cand = dp[i - 1][j - 1] + subCost;
              if (cand < dp[i][j]) {
                dp[i][j] = cand;
                bt[i][j] = 0;
              }
            }
            if (i > 0) {
              const cand = dp[i - 1][j] + GAP_COST;
              if (cand < dp[i][j]) {
                dp[i][j] = cand;
                bt[i][j] = 1;
              }
            }
            if (j > 0) {
              const cand = dp[i][j - 1] + GAP_COST;
              if (cand < dp[i][j]) {
                dp[i][j] = cand;
                bt[i][j] = 2;
              }
            }
          }
        }

        let i = m;
        let j = n;
        while (i > 0 || j > 0) {
          const move = bt[i][j];
          if (i > 0 && j > 0 && move === 0) {
            const domIdx = domFiltered[i - 1].tokenIndex;
            const ttsIdx = ttsFiltered[j - 1].wordIndex;
            if (wordToToken[ttsIdx] === -1) {
              wordToToken[ttsIdx] = domIdx;
            }
            i -= 1;
            j -= 1;
          } else if (i > 0 && (move === 1 || j === 0)) {
            i -= 1;
          } else if (j > 0 && (move === 2 || i === 0)) {
            j -= 1;
          } else {
            break;
          }
        }

        // Propagate nearest known mapping to fill gaps
        let lastSeen = -1;
        for (let k = 0; k < wordToToken.length; k++) {
          if (wordToToken[k] !== -1) {
            lastSeen = wordToToken[k];
          } else if (lastSeen !== -1) {
            wordToToken[k] = lastSeen;
          }
        }
        let nextSeen = -1;
        for (let k = wordToToken.length - 1; k >= 0; k--) {
          if (wordToToken[k] !== -1) {
            nextSeen = wordToToken[k];
          } else if (nextSeen !== -1) {
            wordToToken[k] = nextSeen;
          }
        }
      }

      const mappedIndex =
        wordIndex < wordToToken.length ? wordToToken[wordIndex] : -1;
      if (mappedIndex === -1) {
        return;
      }

      const token = domTokens[mappedIndex];
      const doc = token.node.ownerDocument || (range.commonAncestorContainer as Document);
      const wordRange = doc.createRange();
      wordRange.setStart(token.node, token.startOffset);
      wordRange.setEnd(token.node, token.endOffset);

      try {
        const wordCfi = content.cfiFromRange(wordRange);
        currentWordHighlightCfi.current = wordCfi;
        renditionRef.current.annotations.add(
          'highlight',
          wordCfi,
          {},
          () => { },
          '',
          {
            fill: 'var(--accent)',
            'fill-opacity': '0.4',
            'mix-blend-mode': 'multiply',
          }
        );
      } catch (error) {
        console.error('Error highlighting EPUB word:', error);
      }

      break;
    }
  }, [epubHighlightEnabled, clearWordHighlights]);



  // Context value memoization
  const contextValue = useMemo(
    () => ({
      setCurrentDocument,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      clearCurrDoc,
      extractPageText,
      createFullAudioBook,
      regenerateChapter,
      bookRef,
      renditionRef,
      tocRef,
      locationRef,
      handleLocationChanged,
      setRendition,
      isAudioCombining,
      highlightPattern,
      clearHighlights,
      highlightWordIndex,
      clearWordHighlights,
    }),
    [
      setCurrentDocument,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      clearCurrDoc,
      extractPageText,
      createFullAudioBook,
      regenerateChapter,
      handleLocationChanged,
      setRendition,
      isAudioCombining,
      highlightPattern,
      clearHighlights,
      highlightWordIndex,
      clearWordHighlights,
    ]
  );

  return (
    <EPUBContext.Provider value={contextValue}>
      {children}
    </EPUBContext.Provider>
  );
}

/**
 * Custom hook to consume the EPUB context
 * @returns {EPUBContextType} The EPUB context value
 * @throws {Error} When used outside of EPUBProvider
 */
export function useEPUB() {
  const context = useContext(EPUBContext);
  if (context === undefined) {
    throw new Error('useEPUB must be used within an EPUBProvider');
  }
  return context;
}
