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

import { createEpubAudiobookSourceAdapter } from '@/lib/client/audiobooks/adapters/epub';
import { regenerateAudiobookChapter, runAudiobookGeneration } from '@/lib/client/audiobooks/pipeline';
import { setLastDocumentLocation } from '@/lib/client/dexie';
import { scheduleDocumentProgressSync } from '@/lib/client/api/user-state';
import { getDocumentMetadata } from '@/lib/client/api/documents';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { EpubRenderedLocationCloneManager } from '@/lib/client/epub/rendered-location-walker';
import { canonicalizeEpubSegmentAgainstSpineText } from '@/lib/client/epub/canonicalize-epub-segment';
import { buildEpubLocator, getSpineItemPlainText } from '@/lib/client/epub/spine-coordinates';
import { useTTS, type EpubLocatorResolver } from '@/contexts/TTSContext';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { createRangeCfi } from '@/lib/client/epub';
import { normalizeTtsLocationKey } from '@/lib/shared/tts-locator';
import {
  buildMonotonicWordToTokenMap,
  buildWordHighlightCacheKey,
  tokenizeCanonicalSegment,
  type EpubCanonicalWordToken,
} from '@/lib/shared/epub-word-highlight';
import { useParams } from 'next/navigation';
import { useConfig } from './ConfigContext';
import type {
  EpubRenderedLocationWalker,
  TTSSentenceAlignment,
  TTSAudiobookFormat,
  TTSAudiobookChapter,
} from '@/types/tts';
import type { AudiobookGenerationSettings, TTSSegmentLocator } from '@/types/client';
import { isStableEpubLocator } from '@/types/client';
import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';

interface EPUBContextType {
  currDocData: ArrayBuffer | undefined;
  currDocName: string | undefined;
  currDocPages: number | undefined;
  currDocPage: number | string;
  currDocText: string | undefined;
  setCurrentDocument: (id: string) => Promise<void>;
  clearCurrDoc: () => void;
  extractPageText: (book: Book, rendition: Rendition, shouldPause?: boolean) => Promise<string>;
  walkUpcomingRenderedLocations: EpubRenderedLocationWalker;
  resolveEpubLocator: EpubLocatorResolver;
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
  highlightSegment: (segment: CanonicalTtsSegment | null | undefined) => void;
  clearHighlights: () => void;
  highlightWordIndex: (
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    segment: CanonicalTtsSegment | null | undefined
  ) => void;
  clearWordHighlights: () => void;
}

const EPUBContext = createContext<EPUBContextType | undefined>(undefined);

const EPUB_CONTINUATION_CHARS = 5000;

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

const stepToPreviousNode = (node: Node | null, root: Node): Node | null => {
  if (!node) return null;

  if (node.previousSibling) {
    let prev: Node | null = node.previousSibling;
    while (prev?.lastChild) {
      prev = prev.lastChild;
    }
    return prev;
  }

  let current: Node | null = node.parentNode;
  while (current) {
    if (current === root) {
      return null;
    }
    if (current.previousSibling) {
      let prev: Node | null = current.previousSibling;
      while (prev?.lastChild) {
        prev = prev.lastChild;
      }
      return prev;
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

const getPreviousTextNode = (node: Node | null, root: Node): Text | null => {
  let prev = stepToPreviousNode(node, root);
  while (prev) {
    if (prev.nodeType === Node.TEXT_NODE) {
      return prev as Text;
    }
    prev = stepToPreviousNode(prev, root);
  }
  return null;
};

const getLastTextNodeInSubtree = (node: Node | null): Text | null => {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return node as Text;

  let child: Node | null = node.lastChild;
  while (child) {
    const nested = getLastTextNodeInSubtree(child);
    if (nested) return nested;
    child = child.previousSibling;
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

const collectLeadingContextFromRange = (range: Range | null | undefined, limit = EPUB_CONTINUATION_CHARS): string => {
  if (typeof window === 'undefined' || !range) {
    return '';
  }

  const root = range.commonAncestorContainer;
  if (!root) {
    return '';
  }

  const parts: string[] = [];
  let remaining = limit;

  const prependFromTextNode = (textNode: Text, endOffset: number) => {
    if (remaining <= 0) return;
    const textContent = textNode.textContent || '';
    const safeEnd = Math.max(0, Math.min(endOffset, textContent.length));
    if (safeEnd <= 0) return;
    const safeStart = Math.max(0, safeEnd - remaining);
    const slice = textContent.slice(safeStart, safeEnd);
    if (slice) {
      parts.unshift(slice);
      remaining -= slice.length;
    }
  };

  let cursor: Node | null = null;

  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const startText = range.startContainer as Text;
    prependFromTextNode(startText, range.startOffset);
    cursor = startText;
  } else {
    const startNode = range.startContainer;
    let anchor: Node | null = null;
    if (range.startOffset > 0) {
      anchor = startNode.childNodes[range.startOffset - 1] ?? null;
    }
    if (!anchor) {
      anchor = stepToPreviousNode(startNode, root);
    }

    const anchorText = getLastTextNodeInSubtree(anchor);
    if (anchorText) {
      prependFromTextNode(anchorText, (anchorText.textContent || '').length);
      cursor = anchorText;
    } else {
      cursor = anchor;
    }
  }

  let prevNode = getPreviousTextNode(cursor, root);
  while (prevNode && remaining > 0) {
    prependFromTextNode(prevNode, (prevNode.textContent || '').length);
    prevNode = getPreviousTextNode(prevNode, root);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

type EpubMappedPosition = {
  node: Text;
  offset: number;
};

type EpubMappedChar = {
  char: string;
  position: EpubMappedPosition;
};

type EpubRenderedTextMap = {
  sourceKey: string;
  chars: EpubMappedPosition[];
  content: {
    cfiFromRange: (range: Range) => string;
  };
};

type EpubWordHighlightMapCache = {
  key: string;
  wordToToken: number[];
  tokens: EpubCanonicalWordToken[];
};

const cloneMappedChar = (char: string, source: EpubMappedChar): EpubMappedChar => ({
  char,
  position: source.position,
});

const replaceMappedUrls = (tokens: EpubMappedChar[]): EpubMappedChar[] => {
  const text = tokens.map((token) => token.char).join('');
  const urlPattern = /\S*(?:https?:\/\/|www\.)([^\/\s]+)(?:\/\S*)?/gi;
  const replaced: EpubMappedChar[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = urlPattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    replaced.push(...tokens.slice(cursor, start));

    const anchor = tokens[start] ?? tokens[Math.max(0, end - 1)];
    if (anchor) {
      const replacement = `- (link to ${match[1]}) -`;
      for (const char of replacement) {
        replaced.push(cloneMappedChar(char, anchor));
      }
    }
    cursor = end;
  }

  replaced.push(...tokens.slice(cursor));
  return replaced;
};

const removeMappedHyphenation = (tokens: EpubMappedChar[]): EpubMappedChar[] => {
  const text = tokens.map((token) => token.char).join('');
  const hyphenPattern = /(\w+)-\s+(\w+)/g;
  const replaced: EpubMappedChar[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = hyphenPattern.exec(text)) !== null) {
    const start = match.index;
    const full = match[0];
    const first = match[1];
    const second = match[2];
    const secondOffset = full.lastIndexOf(second);

    replaced.push(...tokens.slice(cursor, start));
    replaced.push(...tokens.slice(start, start + first.length));
    replaced.push(...tokens.slice(start + secondOffset, start + secondOffset + second.length));
    cursor = start + full.length;
  }

  replaced.push(...tokens.slice(cursor));
  return replaced;
};

const normalizeMappedTokensForTts = (tokens: EpubMappedChar[]): EpubMappedChar[] => {
  const withoutLinks = replaceMappedUrls(tokens);
  const withoutHyphenation = removeMappedHyphenation(withoutLinks);
  const normalized: EpubMappedChar[] = [];
  let pendingWhitespace: EpubMappedChar | null = null;

  const flushWhitespace = () => {
    if (!pendingWhitespace || normalized.length === 0 || normalized[normalized.length - 1].char === ' ') {
      pendingWhitespace = null;
      return;
    }
    normalized.push(cloneMappedChar(' ', pendingWhitespace));
    pendingWhitespace = null;
  };

  for (const token of withoutHyphenation) {
    if (token.char === '*') continue;
    if (/\s/.test(token.char)) {
      pendingWhitespace ??= token;
      continue;
    }

    flushWhitespace();
    normalized.push(token);
  }

  if (normalized[normalized.length - 1]?.char === ' ') {
    normalized.pop();
  }

  return normalized;
};

const collectMappedTextFromRange = (range: Range): EpubMappedChar[] => {
  const root = range.commonAncestorContainer;
  const doc = range.startContainer.ownerDocument ?? (range.startContainer as Document);
  const mapped: EpubMappedChar[] = [];

  const addTextSlice = (textNode: Text, start: number, end: number) => {
    const text = textNode.textContent || '';
    const safeStart = Math.max(0, Math.min(start, text.length));
    const safeEnd = Math.max(safeStart, Math.min(end, text.length));
    for (let offset = safeStart; offset < safeEnd; offset += 1) {
      mapped.push({
        char: text[offset],
        position: { node: textNode, offset },
      });
    }
  };

  if (root.nodeType === Node.TEXT_NODE) {
    addTextSlice(root as Text, range.startOffset, range.endOffset);
    return mapped;
  }

  const nodeFilter = doc.defaultView?.NodeFilter ?? NodeFilter;
  const walker = doc.createTreeWalker(
    root,
    nodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        try {
          return range.intersectsNode(node)
            ? nodeFilter.FILTER_ACCEPT
            : nodeFilter.FILTER_REJECT;
        } catch {
          return nodeFilter.FILTER_REJECT;
        }
      },
    },
  );

  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    const text = textNode.textContent || '';
    let start = 0;
    let end = text.length;

    if (textNode === range.startContainer) {
      start = range.startOffset;
    }
    if (textNode === range.endContainer) {
      end = range.endOffset;
    }

    addTextSlice(textNode, start, end);
    textNode = walker.nextNode() as Text | null;
  }

  return mapped;
};

const buildRenderedTextMaps = (
  rendition: Rendition,
  rangeCfi: string,
  sourceKey: string,
): EpubRenderedTextMap[] => {
  const contents = rendition.getContents();
  const contentsArray = Array.isArray(contents) ? contents : [contents];
  const maps: EpubRenderedTextMap[] = [];

  for (const content of contentsArray) {
    try {
      const range = content.range(rangeCfi);
      if (!range) continue;

      const normalized = normalizeMappedTokensForTts(collectMappedTextFromRange(range));
      if (!normalized.length) continue;

      maps.push({
        sourceKey,
        chars: normalized.map((token) => token.position),
        content,
      });
    } catch {
      // Not every displayed iframe can resolve every CFI in spread mode.
    }
  }

  return maps;
};

const createRangeFromMappedOffsets = (
  map: EpubRenderedTextMap,
  startOffset: number,
  endOffset: number,
): Range | null => {
  const start = Math.max(0, Math.min(startOffset, map.chars.length));
  const end = Math.max(start, Math.min(endOffset, map.chars.length));
  if (end <= start) return null;

  const startPosition = map.chars[start];
  const endPosition = map.chars[end - 1];
  if (!startPosition || !endPosition) return null;

  const doc = startPosition.node.ownerDocument;
  const range = doc.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset + 1);
  return range;
};

const resolveVisibleSegmentRange = (
  maps: EpubRenderedTextMap[],
  segment: CanonicalTtsSegment | null | undefined,
): { map: EpubRenderedTextMap; range: Range; startOffset: number; endOffset: number } | null => {
  if (!segment) return null;

  for (const map of maps) {
    const startsInMap = segment.startAnchor.sourceKey === map.sourceKey;
    const endsInMap = segment.endAnchor.sourceKey === map.sourceKey;
    if (!startsInMap && !endsInMap) continue;

    const startOffset = startsInMap ? segment.startAnchor.offset : 0;
    const endOffset = endsInMap ? segment.endAnchor.offset : map.chars.length;
    const range = createRangeFromMappedOffsets(map, startOffset, endOffset);
    if (range) {
      return { map, range, startOffset, endOffset };
    }
  }

  return null;
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
    ttsProvider,
    ttsSegmentMaxBlockLength,
    smartSentenceSplitting,
    epubTheme,
    epubHighlightEnabled,
  } = useConfig();
  // Current document state
  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();
  // Mirror state into a ref so resolveEpubLocator (registered once with
  // TTSContext via a stable callback) can always read the latest page text
  // without forcing re-registration on every page turn.
  const currDocTextRef = useRef<string | undefined>(undefined);
  useEffect(() => { currDocTextRef.current = currDocText; }, [currDocText]);
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
  const renderedTextMapsRef = useRef<EpubRenderedTextMap[]>([]);
  const wordHighlightMapCacheRef = useRef<EpubWordHighlightMapCache | null>(null);
  const renderedLocationCloneManagerRef = useRef<EpubRenderedLocationCloneManager>(
    new EpubRenderedLocationCloneManager(),
  );

  useEffect(() => () => {
    void renderedLocationCloneManagerRef.current.destroy();
  }, []);

  useEffect(() => {
    renderedLocationCloneManagerRef.current.invalidate();
  }, [currDocData]);

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
    renderedTextMapsRef.current = [];
    wordHighlightMapCacheRef.current = null;
    renderedLocationCloneManagerRef.current.invalidate();
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
      const location = rendition?.location;
      if (!location) return '';
      const { start, end } = location;
      if (!start?.cfi || !end?.cfi || !book || !book.isOpen || !rendition) return '';

      const rangeCfi = createRangeCfi(start.cfi, end.cfi);

      const range = await book.getRange(rangeCfi);
      if (!range) {
        console.warn('Failed to get range from CFI:', rangeCfi);
        return '';
      }
      const textContent = range.toString().trim();
      renderedTextMapsRef.current = buildRenderedTextMaps(
        rendition,
        rangeCfi,
        normalizeTtsLocationKey(start.cfi),
      );
      wordHighlightMapCacheRef.current = null;
      const leadingPreview = collectLeadingContextFromRange(range);
      const continuationPreview = collectContinuationFromRange(range);

      if (smartSentenceSplitting) {
        setTTSText(textContent, {
          shouldPause,
          location: start.cfi,
          previousText: leadingPreview,
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
  const loadSpineSection = useCallback(async (href: string) => {
    const book = bookRef.current;
    if (!book?.isOpen) return null;
    const section = book.spine.get(href);
    if (!section) return null;
    const loaded = await Promise.resolve(section.load(book.load.bind(book)));
    const doc = (() => {
      if (!loaded) return null;
      if (typeof Document !== 'undefined' && loaded instanceof Document) {
        return loaded;
      }
      const element = loaded as unknown as Element;
      if (element?.ownerDocument) {
        return element.ownerDocument;
      }
      const sectionWithDocument = section as unknown as { document?: Document };
      return sectionWithDocument.document ?? null;
    })();
    if (!doc) return null;
    return { section, doc };
  }, []);

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
      const filteredArray = textArray.filter(item => item.text.trim() !== '');
      return filteredArray;
    } catch (error) {
      console.error('Error extracting EPUB text:', error);
      return [{ text: '', href: '' }];
    }
  }, [loadSpineSection]);

  /**
   * Resolves a draft EPUB locator (typically `{ readerType: 'epub', location:
   * <CFI> }`) into stable spine coordinates using the live `Book` instance.
   * Registered with TTSContext so segment-persist payloads are normalised to
   * viewport-independent coordinates before they hit the server.
   *
   * Returns null when there's no live book or the CFI doesn't resolve.
   */
  const resolveEpubLocator = useCallback<EpubLocatorResolver>(async (
    draft,
    segmentText,
    options,
  ) => {
    const book = bookRef.current;
    if (!book || !book.isOpen) return null;
    const resolvedLocator = (() => {
      if (isStableEpubLocator(draft)) return Promise.resolve(draft);
      const cfi = (typeof draft.cfi === 'string' && draft.cfi)
        || (typeof draft.location === 'string' && draft.location)
        || '';
      if (!cfi) return Promise.resolve<TTSSegmentLocator | null>(null);
      // Pass the current rendered page's text as the chunk anchor so the
      // per-segment search starts at this page's position in the spine.
      const chunkText = currDocTextRef.current;
      return buildEpubLocator(book, cfi, segmentText, chunkText);
    })();

    const stable = await resolvedLocator;
    if (!stable || !isStableEpubLocator(stable)) return null;

    const spineText = await getSpineItemPlainText(book, stable.spineHref);
    const canonical = canonicalizeEpubSegmentAgainstSpineText({
      segmentText,
      spineText,
      spineHref: stable.spineHref,
      spineIndex: stable.spineIndex,
      hintCharOffset: stable.charOffset,
      cfi: stable.cfi,
      keyPrefix: options?.keyPrefix,
      maxBlockLength: options?.maxBlockLength ?? ttsSegmentMaxBlockLength,
    });
    if (!canonical) return null;

    return {
      locator: canonical.locator,
      segmentKey: canonical.segmentKey,
      segmentIndex: canonical.segmentIndex,
      text: canonical.text,
    };
  }, [ttsSegmentMaxBlockLength]);

  const walkUpcomingRenderedLocations = useCallback<EpubRenderedLocationWalker>(async (startCfi, depth, signal) => {
    if (!startCfi || depth <= 0 || signal.aborted) return [];
    const visibleRendition = renditionRef.current;
    if (!currDocData || !visibleRendition || typeof document === 'undefined') return [];

    const visibleSettings = (visibleRendition as unknown as {
      settings?: {
        spread?: string;
      };
      manager?: { stage?: { container?: Element | null }; container?: Element | null };
    }).settings;
    const containerElement =
      (visibleRendition as unknown as { manager?: { stage?: { container?: Element | null }; container?: Element | null } }).manager?.stage?.container
      ?? (visibleRendition as unknown as { manager?: { container?: Element | null } }).manager?.container
      ?? null;
    const bounds = containerElement?.getBoundingClientRect?.();
    const width = Math.max(320, Math.floor(bounds?.width || 900));
    const height = Math.max(320, Math.floor(bounds?.height || 700));

    const visibleContents = typeof visibleRendition.getContents === 'function'
      ? visibleRendition.getContents()
      : [];
    const visibleContent = Array.isArray(visibleContents) ? visibleContents[0] : visibleContents;
    const contentDoc = (visibleContent as { document?: Document | null } | null | undefined)?.document ?? null;
    const contentBody = contentDoc?.body ?? null;
    const bodyStyle = contentBody ? getComputedStyle(contentBody) : null;

    const theme = epubTheme
      ? {
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground'),
        base: getComputedStyle(document.documentElement).getPropertyValue('--base'),
        fontFamily: bodyStyle?.fontFamily || undefined,
        fontSize: bodyStyle?.fontSize || undefined,
        lineHeight: bodyStyle?.lineHeight || undefined,
        fontWeight: bodyStyle?.fontWeight || undefined,
        letterSpacing: bodyStyle?.letterSpacing || undefined,
        wordSpacing: bodyStyle?.wordSpacing || undefined,
      }
      : null;

    return renderedLocationCloneManagerRef.current.walk({
      data: currDocData,
      startCfi,
      depth,
      signal,
      width,
      height,
      spread: visibleSettings?.spread,
      theme,
    });
  }, [currDocData, epubTheme]);

  const audiobookAdapter = useMemo(() => createEpubAudiobookSourceAdapter({
    extractBookText,
    getTocItems: () => tocRef.current || [],
  }), [extractBookText]);

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
      return await runAudiobookGeneration({
        adapter: audiobookAdapter,
        apiKey,
        baseUrl,
        defaultProvider: ttsProvider,
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
  }, [audiobookAdapter, apiKey, baseUrl, ttsProvider]);

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
      return await regenerateAudiobookChapter({
        adapter: audiobookAdapter,
        chapterIndex,
        bookId,
        format,
        signal,
        apiKey,
        baseUrl,
        defaultProvider: ttsProvider,
        settings,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))) {
        throw new Error('Chapter regeneration cancelled');
      }
      console.error('Error regenerating chapter:', error);
      throw error;
    }
  }, [audiobookAdapter, apiKey, baseUrl, ttsProvider]);

  const setRendition = useCallback((rendition: Rendition) => {
    bookRef.current = rendition.book;
    renditionRef.current = rendition;
  }, []);

  const safeRenditionNavigate = useCallback((navigation: 'next' | 'prev' | 'display', location?: string) => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    if (!book?.isOpen || !rendition) return false;

    const guardNavigationPromise = (promiseLike: unknown): void => {
      const promise = Promise.resolve(promiseLike);
      void promise.catch((error) => {
        console.warn(`EPUB rendition ${navigation} failed:`, error);
      });
    };

    try {
      if (navigation === 'display') {
        if (!location) return false;
        guardNavigationPromise(rendition.display(location));
        return true;
      }
      if (navigation === 'next') {
        guardNavigationPromise(rendition.next());
        return true;
      }
      guardNavigationPromise(rendition.prev());
      return true;
    } catch (error) {
      console.warn(`EPUB rendition ${navigation} failed:`, error);
      return false;
    }
  }, []);

  const handleLocationChanged = useCallback((location: string | number) => {
    // Handle directional navigation before first-location initialization so
    // "prev"/"next" are not treated as raw CFI strings.
    if ((location === 'next' || location === 'prev') && renditionRef.current) {
      if (!isEPUBSetOnce.current) {
        setIsEPUB(true);
        isEPUBSetOnce.current = true;
      }
      shouldPauseRef.current = false;
      safeRenditionNavigate(location === 'next' ? 'next' : 'prev');
      return;
    }

    // Set the EPUB flag once the location changes
    if (!isEPUBSetOnce.current) {
      setIsEPUB(true);
      isEPUBSetOnce.current = true;

      safeRenditionNavigate('display', location.toString());
      return;
    }

    if (!bookRef.current?.isOpen || !renditionRef.current) return;

    // If the location is a CFI string that doesn't match the current rendered position,
    // navigate there and let the subsequent locationChanged callback handle text extraction.
    if (typeof location === 'string' && location !== 'next' && location !== 'prev' && renditionRef.current?.location) {
      const currentStartCfi = renditionRef.current.location?.start?.cfi;
      if (currentStartCfi && location !== currentStartCfi) {
        // Programmatic cross-location jumps (segments sidebar / TTS navigation)
        // should keep autoplay intent after the rendition finishes navigating.
        shouldPauseRef.current = false;
        safeRenditionNavigate('display', location);
        return;
      }
    }

    // Handle special 'next' and 'prev' cases
    if (location === 'next' && renditionRef.current) {
      shouldPauseRef.current = false;
      safeRenditionNavigate('next');
      return;
    }
    if (location === 'prev' && renditionRef.current) {
      shouldPauseRef.current = false;
      safeRenditionNavigate('prev');
      return;
    }

    // Save the location to IndexedDB if not initial
    if (id && locationRef.current !== 1) {
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
  }, [id, skipToLocation, extractPageText, setIsEPUB, authEnabled, safeRenditionNavigate]);

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

  const highlightSegment = useCallback((segment: CanonicalTtsSegment | null | undefined) => {
    if (!renditionRef.current) return;

    clearHighlights();

    if (!epubHighlightEnabled || !segment) return;

    const resolved = resolveVisibleSegmentRange(renderedTextMapsRef.current, segment);
    if (!resolved) return;

    try {
      const cfi = resolved.map.content.cfiFromRange(resolved.range);
      currentHighlightCfi.current = cfi;
      renditionRef.current.annotations.add(
        'highlight',
        cfi,
        {},
        () => { },
        '',
        { fill: 'grey', 'fill-opacity': '0.4', 'mix-blend-mode': 'multiply' },
      );
    } catch (error) {
      console.error('Error highlighting EPUB segment:', error);
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
    segment: CanonicalTtsSegment | null | undefined
  ) => {
    clearWordHighlights();

    if (!epubHighlightEnabled) return;
    if (!alignment) return;
    if (wordIndex === null || wordIndex === undefined || wordIndex < 0) return;

    const words = alignment.words || [];
    if (!words.length || wordIndex >= words.length) return;

    if (!renditionRef.current) return;

    if (!segment || segment.startAnchor.sourceKey !== segment.ownerSourceKey) return;

    const resolved = resolveVisibleSegmentRange(renderedTextMapsRef.current, segment);
    if (!resolved || segment.startAnchor.sourceKey !== resolved.map.sourceKey) return;

    const cacheKey = buildWordHighlightCacheKey(segment, alignment);
    if (wordHighlightMapCacheRef.current?.key !== cacheKey) {
      const tokens = tokenizeCanonicalSegment(segment);
      wordHighlightMapCacheRef.current = {
        key: cacheKey,
        tokens,
        wordToToken: buildMonotonicWordToTokenMap(words, tokens),
      };
    }

    const cached = wordHighlightMapCacheRef.current;
    const tokenIndex = cached.wordToToken[wordIndex] ?? -1;
    if (tokenIndex < 0) return;

    const token = cached.tokens[tokenIndex];
    if (!token) return;
    if (token.sourceStart < resolved.startOffset || token.sourceEnd > resolved.endOffset) return;

    const wordRange = createRangeFromMappedOffsets(resolved.map, token.sourceStart, token.sourceEnd);
    if (!wordRange) return;

    try {
      const wordCfi = resolved.map.content.cfiFromRange(wordRange);
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
      walkUpcomingRenderedLocations,
      resolveEpubLocator,
      createFullAudioBook,
      regenerateChapter,
      bookRef,
      renditionRef,
      tocRef,
      locationRef,
      handleLocationChanged,
      setRendition,
      isAudioCombining,
      highlightSegment,
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
      walkUpcomingRenderedLocations,
      resolveEpubLocator,
      createFullAudioBook,
      regenerateChapter,
      handleLocationChanged,
      setRendition,
      isAudioCombining,
      highlightSegment,
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
