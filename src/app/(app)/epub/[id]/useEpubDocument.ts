'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type { Book, NavItem, Rendition } from 'epubjs';

import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { useEPUBHighlighting } from '@/hooks/epub/useEPUBHighlighting';
import { useEPUBLocationController } from '@/hooks/epub/useEPUBLocationController';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { createRangeCfi } from '@/lib/client/epub';
import {
  buildRenderedTextMaps,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import {
  clearEpubWindowIndex,
  resolveEpubLocatorToCfi,
} from '@/lib/client/epub/location-index';
import {
  IDLE_EPUB_PLACEMENT,
  readEpubCommittedLocation,
  type EpubCommittedLocation,
  type EpubPlacementLifecycle,
} from '@/lib/client/epub/plan-backed-placement';
import { buildEpubRangeStartAnchor } from '@/lib/client/epub/spine-coordinates';
import { normalizeTtsLocationKey } from '@openreader/tts/locator';
import { normalizeOptionalLanguageTag } from '@openreader/tts/language';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { BaseDocument } from '@/types/documents';
import type { TTSSegmentLocator } from '@/types/client';
import type { TTSSentenceAlignment } from '@/types/tts';
import type { ScheduleDocumentProgress } from '@/types/user-state';
import type { EpubProgressLocator } from '@/types/user-state';

type RefreshRenderedPlacement = (
  shouldPause?: boolean,
) => Promise<void>;

type RequestCommittedPlacement = (
  book: Book,
  rendition: Rendition,
  location: EpubCommittedLocation,
  shouldPause?: boolean,
) => Promise<void>;

export interface EpubDocumentState {
  currDocData: ArrayBuffer | undefined;
  currDocName: string | undefined;
  currDocPages: number | undefined;
  currDocPage: number | string;
  metadataLanguage: string | null;
  isMetadataReady: boolean;
  isPlaybackReady: boolean;
  placementLifecycle: EpubPlacementLifecycle;
  renderedTextRevision: number;
  renditionAttempt: number;
  setCurrentDocument: (metadata: BaseDocument, initialLocator: EpubProgressLocator | null) => Promise<void>;
  clearCurrDoc: () => void;
  refreshRenderedPlacement: RefreshRenderedPlacement;
  retryPlacement: () => void;
  failPlacement: (error: Error) => void;
  bookRef: RefObject<Book | null>;
  renditionRef: RefObject<Rendition | undefined>;
  tocRef: RefObject<NavItem[]>;
  handleLocationChanged: (location: string | number | TTSSegmentLocator) => void;
  setRendition: (rendition: Rendition) => void;
  highlightSegment: (segment: CanonicalTtsSegment | null | undefined) => boolean;
  clearHighlights: () => void;
  highlightWordIndex: (
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    segment: CanonicalTtsSegment | null | undefined
  ) => void;
  clearWordHighlights: () => void;
}

/**
 * Route-local EPUB reader state. EPUB.js owns rendering; the worker plan owns
 * every playback row. A rendered location becomes ready only after its stable
 * spine anchor resolves to an ordinal from that already-applied plan.
 */
export function useEpubDocument(
  documentId: string | undefined,
  scheduleProgress: ScheduleDocumentProgress,
): EpubDocumentState {
  const {
    currDocPage,
    currDocPages,
    playbackPlanLifecycle,
    playbackPlanSegmentCount,
    reconcileEpubRenderedAnchor,
    resolveEpubPlanLocator,
    setCurrDocPages,
    setIsEPUB,
    stop,
  } = useTTS();
  const { epubHighlightEnabled } = useConfig();

  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [metadataLanguage, setMetadataLanguage] = useState<string | null>(null);
  const [isMetadataReady, setIsMetadataReady] = useState(false);
  const [placementLifecycle, setPlacementLifecycle] = useState<EpubPlacementLifecycle>(IDLE_EPUB_PLACEMENT);
  const [renderedTextRevision, setRenderedTextRevision] = useState(0);
  const [isRenditionReady, setIsRenditionReady] = useState(false);
  const [renditionAttempt, setRenditionAttempt] = useState(0);

  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | undefined>(undefined);
  const tocRef = useRef<NavItem[]>([]);
  const isEPUBSetOnce = useRef(false);
  const renditionEventsCleanupRef = useRef<(() => void) | null>(null);
  const shouldPauseRef = useRef(true);
  const renderedTextMapsRef = useRef<EpubRenderedTextMap[]>([]);
  const placementOwnerRef = useRef(0);
  const completedPlacementCfiRef = useRef<string | null>(null);
  const committedLocationRef = useRef<EpubCommittedLocation | null>(null);
  const playbackPlanReadyRef = useRef(false);
  const requestPlacementRef = useRef<RequestCommittedPlacement | null>(null);
  const initialLocatorRef = useRef<EpubProgressLocator | null>(null);
  const startupDisplayStartedRef = useRef(false);
  const startupDisplayOwnerRef = useRef(0);

  const {
    clearHighlights,
    highlightSegment,
    clearWordHighlights,
    highlightWordIndex,
    setRenderedTextMaps,
    resetHighlightState,
  } = useEPUBHighlighting({
    epubHighlightEnabled,
    renderedTextMapsRef,
  });

  const resetPlacement = useCallback((status: EpubPlacementLifecycle['status'] = 'idle') => {
    placementOwnerRef.current += 1;
    completedPlacementCfiRef.current = null;
    committedLocationRef.current = null;
    startupDisplayOwnerRef.current += 1;
    startupDisplayStartedRef.current = false;
    setPlacementLifecycle({ status, error: null });
  }, []);

  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    setMetadataLanguage(null);
    setIsMetadataReady(false);
    setCurrDocPages(undefined);
    isEPUBSetOnce.current = false;
    shouldPauseRef.current = true;
    clearEpubWindowIndex(bookRef.current);
    bookRef.current = null;
    renditionEventsCleanupRef.current?.();
    renditionEventsCleanupRef.current = null;
    renditionRef.current = undefined;
    setIsRenditionReady(false);
    initialLocatorRef.current = null;
    tocRef.current = [];
    resetPlacement();
    setRenderedTextRevision(0);
    resetHighlightState();
    stop();
  }, [resetHighlightState, resetPlacement, setCurrDocPages, stop]);

  const setCurrentDocument = useCallback(async (
    meta: BaseDocument,
    initialLocator: EpubProgressLocator | null,
  ): Promise<void> => {
    try {
      setMetadataLanguage(null);
      setIsMetadataReady(false);
      clearEpubWindowIndex(bookRef.current);
      bookRef.current = null;
      renditionEventsCleanupRef.current?.();
      renditionEventsCleanupRef.current = null;
      renditionRef.current = undefined;
      setIsRenditionReady(false);
      initialLocatorRef.current = initialLocator;
      isEPUBSetOnce.current = false;
      shouldPauseRef.current = true;
      resetPlacement();

      const doc = await ensureCachedDocument(meta);
      if (doc.type !== 'epub') throw new Error('Document is not an EPUB');
      if (doc.data.byteLength === 0) throw new Error('Empty document data');

      setCurrDocName(doc.name);
      setCurrDocData(doc.data);
    } catch (error) {
      console.error('Failed to get EPUB document:', error);
      clearCurrDoc();
      throw error;
    }
  }, [clearCurrDoc, resetPlacement]);

  const runRenderedPlacement = useCallback(async (
    owner: number,
    book: Book,
    rendition: Rendition,
    location: EpubCommittedLocation,
    shouldPause: boolean,
  ): Promise<void> => {
    const ownsPlacement = () => (
      placementOwnerRef.current === owner
      && bookRef.current === book
      && renditionRef.current === rendition
    );
    try {
      if (!book.isOpen) throw new Error('The EPUB renderer closed before placement completed.');

      const { startCfi, endCfi } = location;

      // An authoritative empty plan needs rendition readiness, but there is no
      // ordinal to map. Complete it before DOM range extraction so an empty book
      // or non-text cover page cannot deadlock the reader gate.
      if (playbackPlanLifecycle.status === 'ready' && playbackPlanSegmentCount === 0) {
        const emptyResult = reconcileEpubRenderedAnchor({
          locator: null,
          hasReadableText: false,
          shouldPause,
        });
        if (!ownsPlacement()) return;
        if (emptyResult.status !== 'empty-plan') {
          throw new Error('The authoritative empty EPUB plan could not complete placement.');
        }
        setRenderedTextMaps([]);
        completedPlacementCfiRef.current = startCfi;
        shouldPauseRef.current = true;
        setPlacementLifecycle({ status: 'empty-plan', error: null });
        return;
      }

      const rangeCfi = createRangeCfi(startCfi, endCfi);
      const range = await book.getRange(rangeCfi);
      if (!ownsPlacement()) return;
      if (!range) throw new Error('EPUB.js could not resolve the committed location to rendered text.');

      const textContent = range.toString().trim();
      const startAnchor = buildEpubRangeStartAnchor(book, startCfi, range);
      if (!ownsPlacement()) return;
      if (!startAnchor) {
        throw new Error('The rendered EPUB position could not be mapped to a stable spine anchor.');
      }

      const locator: TTSSegmentLocator = {
        readerType: 'epub',
        spineHref: startAnchor.spineHref,
        spineIndex: startAnchor.spineIndex,
        charOffset: startAnchor.charOffset,
      };
      setRenderedTextMaps(buildRenderedTextMaps(
        rendition,
        rangeCfi,
        normalizeTtsLocationKey(startCfi),
        startAnchor,
      ));
      // Rendered maps are part of the surface commit. They live in refs for
      // range lookup, so publish an explicit revision that makes an unchanged
      // selected ordinal repaint against the newly committed rendition.
      setRenderedTextRevision((revision) => revision + 1);

      const result = reconcileEpubRenderedAnchor({
        locator,
        hasReadableText: Boolean(textContent),
        shouldPause,
      });
      if (!ownsPlacement()) return;

      if (result.status === 'waiting-plan') {
        setPlacementLifecycle({ status: 'waiting-plan', error: null });
        return;
      }
      if (result.status === 'invalid-anchor') {
        throw new Error('The rendered EPUB anchor was not a stable spine coordinate.');
      }
      if (result.status === 'unmapped-anchor') {
        throw new Error('The rendered EPUB position did not map to the authoritative playback plan.');
      }
      if (result.status === 'selected' && documentId) {
        scheduleProgress({
          documentId,
          readerType: 'epub',
          locator: {
            schemaVersion: 1,
            spineHref: startAnchor.spineHref,
            spineIndex: startAnchor.spineIndex,
            charOffset: startAnchor.charOffset,
          },
        });
      }

      completedPlacementCfiRef.current = startCfi;
      shouldPauseRef.current = true;
      if (!ownsPlacement()) return;
      setPlacementLifecycle({
        status: result.status === 'empty-plan' ? 'empty-plan' : 'ready',
        error: null,
      });
    } catch (error) {
      const resolved = error instanceof Error ? error : new Error('Failed to place the EPUB reader');
      if (!ownsPlacement()) return;
      console.error('Failed to reconcile rendered EPUB position:', resolved);
      setPlacementLifecycle({ status: 'failed', error: resolved });
    }
  }, [
    playbackPlanLifecycle.status,
    playbackPlanSegmentCount,
    reconcileEpubRenderedAnchor,
    documentId,
    scheduleProgress,
    setPlacementLifecycle,
    setRenderedTextMaps,
  ]);

  playbackPlanReadyRef.current = playbackPlanLifecycle.status === 'ready';

  const requestCommittedPlacement = useCallback<RequestCommittedPlacement>(async (
    book,
    rendition,
    location,
    shouldPause = false,
  ) => {
    if (!playbackPlanReadyRef.current) {
      setPlacementLifecycle({ status: 'waiting-plan', error: null });
      return;
    }
    if (
      completedPlacementCfiRef.current === location.startCfi
    ) return;

    const owner = placementOwnerRef.current + 1;
    placementOwnerRef.current = owner;
    setPlacementLifecycle({ status: 'placing', error: null });
    await runRenderedPlacement(owner, book, rendition, location, shouldPause);
  }, [runRenderedPlacement]);
  requestPlacementRef.current = requestCommittedPlacement;

  const refreshRenderedPlacement = useCallback<RefreshRenderedPlacement>(async (
    shouldPause = false,
  ) => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    if (!book?.isOpen || !rendition) return;
    const location = committedLocationRef.current ?? readEpubCommittedLocation(rendition.location);
    if (!location) return;
    committedLocationRef.current = location;
    completedPlacementCfiRef.current = null;
    await requestCommittedPlacement(book, rendition, location, shouldPause);
  }, [requestCommittedPlacement]);

  const issueInitialDisplay = useCallback(async (): Promise<void> => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    if (
      !book?.isOpen
      || !rendition
      || !playbackPlanReadyRef.current
      || startupDisplayStartedRef.current
    ) return;

    const owner = startupDisplayOwnerRef.current + 1;
    startupDisplayOwnerRef.current = owner;
    startupDisplayStartedRef.current = true;
    setPlacementLifecycle({ status: 'placing', error: null });
    const ownsDisplay = () => (
      startupDisplayOwnerRef.current === owner
      && bookRef.current === book
      && renditionRef.current === rendition
    );

    try {
      const saved = initialLocatorRef.current;
      const resolution = resolveEpubPlanLocator(saved ? {
        readerType: 'epub',
        spineHref: saved.spineHref,
        spineIndex: saved.spineIndex,
        charOffset: saved.charOffset,
      } : null);
      if (resolution.status === 'waiting-plan') {
        throw new Error('The authoritative EPUB plan was not available for initial placement.');
      }
      if (resolution.status === 'invalid-locator') {
        throw new Error('The authoritative EPUB plan does not contain a stable initial locator.');
      }
      if (resolution.status === 'unmapped-locator') {
        throw new Error('The saved EPUB position does not map to the authoritative playback plan.');
      }

      let displayTarget: string | undefined;
      if (resolution.status === 'selected') {
        const resolved = await resolveEpubLocatorToCfi(book, resolution.displayLocator);
        if (!ownsDisplay()) return;
        if (!resolved) {
          throw new Error('The stable EPUB position could not be resolved by the rendition.');
        }
        displayTarget = resolved;
      }

      await Promise.resolve(displayTarget ? rendition.display(displayTarget) : rendition.display());
      if (!ownsDisplay()) return;
    } catch (error) {
      if (!ownsDisplay()) return;
      const resolved = error instanceof Error ? error : new Error('Failed to place the EPUB reader');
      console.error('Failed to issue the EPUB startup display:', resolved);
      setPlacementLifecycle({ status: 'failed', error: resolved });
    }
  }, [resolveEpubPlanLocator]);

  useEffect(() => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    if (!book?.isOpen || !rendition) return;
    completedPlacementCfiRef.current = null;
    placementOwnerRef.current += 1;
    if (playbackPlanLifecycle.status !== 'ready') {
      setPlacementLifecycle({ status: 'waiting-plan', error: null });
      return;
    }
    if (!committedLocationRef.current) {
      void issueInitialDisplay();
      return;
    }
    void refreshRenderedPlacement(shouldPauseRef.current);
  }, [isRenditionReady, issueInitialDisplay, playbackPlanLifecycle.status, refreshRenderedPlacement]);

  const failPlacement = useCallback((error: Error) => {
    placementOwnerRef.current += 1;
    startupDisplayOwnerRef.current += 1;
    completedPlacementCfiRef.current = null;
    setPlacementLifecycle({ status: 'failed', error });
  }, []);

  const retryPlacement = useCallback(() => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    completedPlacementCfiRef.current = null;
    if (!book?.isOpen || !rendition) {
      setIsRenditionReady(false);
      setPlacementLifecycle({ status: 'placing', error: null });
      setRenditionAttempt((attempt) => attempt + 1);
      return;
    }
    if (!committedLocationRef.current) {
      startupDisplayStartedRef.current = false;
      void issueInitialDisplay();
      return;
    }
    void refreshRenderedPlacement(true);
  }, [issueInitialDisplay, refreshRenderedPlacement]);

  const setRendition = useCallback((rendition: Rendition) => {
    renditionEventsCleanupRef.current?.();
    const book = rendition.book;
    bookRef.current = book;
    renditionRef.current = rendition;
    setIsRenditionReady(true);
    committedLocationRef.current = null;
    completedPlacementCfiRef.current = null;
    placementOwnerRef.current += 1;
    startupDisplayOwnerRef.current += 1;
    startupDisplayStartedRef.current = false;
    setPlacementLifecycle({
      status: playbackPlanReadyRef.current ? 'placing' : 'waiting-plan',
      error: null,
    });

    const commitLocation = (candidate: unknown) => {
      if (renditionRef.current !== rendition || !book.isOpen) return;
      const location = readEpubCommittedLocation(candidate);
      if (!location) return;
      committedLocationRef.current = location;
      if (!isEPUBSetOnce.current) {
        setIsEPUB(true);
        isEPUBSetOnce.current = true;
      }
      void requestPlacementRef.current?.(
        book,
        rendition,
        location,
        shouldPauseRef.current,
      );
    };
    const requestFromRendered = () => commitLocation(rendition.location);
    const requestFromRelocated = (location: unknown) => commitLocation(location ?? rendition.location);

    rendition.on('rendered', requestFromRendered);
    rendition.on('relocated', requestFromRelocated);
    renditionEventsCleanupRef.current = () => {
      rendition.off('rendered', requestFromRendered);
      rendition.off('relocated', requestFromRelocated);
    };

    void book.loaded.metadata
      .then((metadata) => {
        if (bookRef.current !== book) return;
        setMetadataLanguage(normalizeOptionalLanguageTag(metadata.language));
        setIsMetadataReady(true);
      })
      .catch((error) => {
        if (bookRef.current !== book) return;
        setMetadataLanguage(null);
        setIsMetadataReady(true);
        console.warn('Failed to read EPUB language metadata:', error);
      });
  }, [setIsEPUB]);

  const resolveLocatorToCfi = useCallback((locator: TTSSegmentLocator) => (
    resolveEpubLocatorToCfi(bookRef.current, locator)
  ), []);

  const handleLocationChanged = useEPUBLocationController({
    isEpubSetOnceRef: isEPUBSetOnce,
    shouldPauseRef,
    setIsEpub: setIsEPUB,
    bookRef,
    renditionRef,
    resolveLocatorToCfi,
  });

  const isPlaybackReady = placementLifecycle.status === 'ready'
    || placementLifecycle.status === 'empty-plan';

  return useMemo(() => ({
    setCurrentDocument,
    currDocData,
    currDocName,
    currDocPages,
    currDocPage,
    metadataLanguage,
    isMetadataReady,
    isPlaybackReady,
    placementLifecycle,
    renderedTextRevision,
    renditionAttempt,
    clearCurrDoc,
    refreshRenderedPlacement,
    retryPlacement,
    failPlacement,
    bookRef,
    renditionRef,
    tocRef,
    handleLocationChanged,
    setRendition,
    highlightSegment,
    clearHighlights,
    highlightWordIndex,
    clearWordHighlights,
  }), [
    setCurrentDocument,
    currDocData,
    currDocName,
    currDocPages,
    currDocPage,
    metadataLanguage,
    isMetadataReady,
    isPlaybackReady,
    placementLifecycle,
    renderedTextRevision,
    renditionAttempt,
    clearCurrDoc,
    refreshRenderedPlacement,
    retryPlacement,
    failPlacement,
    handleLocationChanged,
    setRendition,
    highlightSegment,
    clearHighlights,
    highlightWordIndex,
    clearWordHighlights,
  ]);
}
