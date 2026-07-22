'use client';

import { useCallback, type MutableRefObject, type RefObject } from 'react';
import type { Book, Rendition } from 'epubjs';

import type { TTSSegmentLocator } from '@/types/client';
import { isStableEpubLocator } from '@/types/client';

import {
  isDirectionalEpubLocation,
  shouldNavigateToDifferentCfi,
  type EpubLocation,
} from '@/lib/client/epub/location-controller';

type UseEpubLocationControllerParams = {
  isEpubSetOnceRef: MutableRefObject<boolean>;
  shouldPauseRef: MutableRefObject<boolean>;
  setIsEpub: (isEpub: boolean) => void;
  bookRef: RefObject<Book | null>;
  renditionRef: RefObject<Rendition | undefined>;
  resolveLocatorToCfi: (locator: TTSSegmentLocator) => Promise<string | null>;
};

function isEpubLocatorTarget(value: EpubLocation | TTSSegmentLocator): value is TTSSegmentLocator {
  return !!value && typeof value === 'object' && isStableEpubLocator(value);
}

export function useEPUBLocationController({
  isEpubSetOnceRef,
  shouldPauseRef,
  setIsEpub,
  bookRef,
  renditionRef,
  resolveLocatorToCfi,
}: UseEpubLocationControllerParams): (location: EpubLocation | TTSSegmentLocator) => void {
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

  const handleLocationChanged = useCallback((location: EpubLocation | TTSSegmentLocator) => {
    if (isEpubLocatorTarget(location)) {
      if (!isEpubSetOnceRef.current) {
        setIsEpub(true);
        isEpubSetOnceRef.current = true;
      }
      shouldPauseRef.current = false;
      void resolveLocatorToCfi(location)
        .then((cfi) => {
          if (!cfi) {
            console.warn('Unable to resolve EPUB locator to CFI:', location);
            return;
          }
          console.log('[cursor-follow] display cfi', {
            spineIndex: location.spineIndex,
            charOffset: location.charOffset,
            resolvedCfi: cfi,
          });
          safeRenditionNavigate('display', cfi);
        })
        .catch((error) => {
          console.warn('EPUB locator navigation failed:', error);
        });
      return;
    }

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

  }, [
    bookRef,
    isEpubSetOnceRef,
    renditionRef,
    safeRenditionNavigate,
    setIsEpub,
    shouldPauseRef,
    resolveLocatorToCfi,
  ]);

  return handleLocationChanged;
}
