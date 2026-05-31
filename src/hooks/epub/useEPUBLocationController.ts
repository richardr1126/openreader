'use client';

import { useCallback, type MutableRefObject, type RefObject } from 'react';
import type { Book, Rendition } from 'epubjs';

import { setLastDocumentLocation } from '@/lib/client/dexie';
import { scheduleDocumentProgressSync } from '@/lib/client/api/user-state';

type EpubLocation = string | number;

export function isDirectionalEpubLocation(location: EpubLocation): location is 'next' | 'prev' {
  return location === 'next' || location === 'prev';
}

export function shouldNavigateToDifferentCfi(
  location: EpubLocation,
  currentStartCfi: string | undefined,
): location is string {
  return (
    typeof location === 'string'
    && !isDirectionalEpubLocation(location)
    && !!currentStartCfi
    && location !== currentStartCfi
  );
}

export function shouldPersistEpubLocation(
  documentId: string | undefined,
  previousLocation: EpubLocation,
): documentId is string {
  return typeof documentId === 'string' && documentId.length > 0 && previousLocation !== 1;
}

type UseEpubLocationControllerParams = {
  documentId?: string;
  isEpubSetOnceRef: MutableRefObject<boolean>;
  shouldPauseRef: MutableRefObject<boolean>;
  setIsEpub: (isEpub: boolean) => void;
  skipToLocation: (location: EpubLocation) => void;
  extractPageText: (book: Book, rendition: Rendition, shouldPause?: boolean) => Promise<string>;
  bookRef: RefObject<Book | null>;
  renditionRef: RefObject<Rendition | undefined>;
  locationRef: RefObject<EpubLocation>;
};

export function useEPUBLocationController({
  documentId,
  isEpubSetOnceRef,
  shouldPauseRef,
  setIsEpub,
  skipToLocation,
  extractPageText,
  bookRef,
  renditionRef,
  locationRef,
}: UseEpubLocationControllerParams): (location: EpubLocation) => void {
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
  }, [bookRef, renditionRef]);

  const handleLocationChanged = useCallback((location: EpubLocation) => {
    // Handle directional navigation before first-location initialization so
    // "prev"/"next" are not treated as raw CFI strings.
    if (isDirectionalEpubLocation(location) && renditionRef.current) {
      if (!isEpubSetOnceRef.current) {
        setIsEpub(true);
        isEpubSetOnceRef.current = true;
      }
      shouldPauseRef.current = false;
      safeRenditionNavigate(location === 'next' ? 'next' : 'prev');
      return;
    }

    // Set the EPUB flag once the location changes
    if (!isEpubSetOnceRef.current) {
      setIsEpub(true);
      isEpubSetOnceRef.current = true;

      safeRenditionNavigate('display', location.toString());
      return;
    }

    if (!bookRef.current?.isOpen || !renditionRef.current) return;

    // If the location is a CFI string that doesn't match the current rendered position,
    // navigate there and let the subsequent locationChanged callback handle text extraction.
    if (renditionRef.current?.location) {
      const currentStartCfi = renditionRef.current.location?.start?.cfi;
      if (shouldNavigateToDifferentCfi(location, currentStartCfi)) {
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
    if (shouldPersistEpubLocation(documentId, locationRef.current)) {
      setLastDocumentLocation(documentId, location.toString());
      scheduleDocumentProgressSync({
        documentId,
        readerType: 'epub',
        location: location.toString(),
      });
    }

    skipToLocation(location);

    locationRef.current = location;
    if (bookRef.current && renditionRef.current) {
      extractPageText(bookRef.current, renditionRef.current, shouldPauseRef.current);
      shouldPauseRef.current = true;
    }
  }, [
    bookRef,
    documentId,
    extractPageText,
    isEpubSetOnceRef,
    locationRef,
    renditionRef,
    safeRenditionNavigate,
    setIsEpub,
    shouldPauseRef,
    skipToLocation,
  ]);

  return handleLocationChanged;
}
