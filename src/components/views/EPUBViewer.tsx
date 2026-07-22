'use client';

import { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import type { Book, NavItem, Rendition } from 'epubjs';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useEPUBTheme } from '@/hooks/epub/useEPUBTheme';
import { useEPUBResize } from '@/hooks/epub/useEPUBResize';
import { DotsVerticalIcon, ChevronLeftIcon, ChevronRightIcon } from '@/components/icons/Icons';
import type { EpubDocumentState } from '@/app/(app)/epub/[id]/useEpubDocument';
import { ToolbarButton } from '@/components/ui';

interface EPUBViewerProps {
  className?: string;
  onError?: (error: Error) => void;
  epubState: Pick<
    EpubDocumentState,
    | 'currDocData'
    | 'currDocPage'
    | 'currDocPages'
    | 'renditionAttempt'
    | 'renderedTextRevision'
    | 'handleLocationChanged'
    | 'bookRef'
    | 'renditionRef'
    | 'tocRef'
    | 'setRendition'
    | 'refreshRenderedPlacement'
    | 'highlightSegment'
    | 'clearHighlights'
    | 'highlightWordIndex'
    | 'clearWordHighlights'
  >;
}

function EpubRenditionHost({
  data,
  attempt,
  onError,
  onRendition,
  onToc,
}: {
  data: ArrayBuffer;
  attempt: number;
  onError?: (error: Error) => void;
  onRendition: (rendition: Rendition) => void;
  onToc: (toc: NavItem[]) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let book: Book | null = null;
    let rendition: Rendition | null = null;

    void import('epubjs')
      .then(async ({ default: createBook }) => {
        book = createBook(data);
        const [, navigation] = await Promise.all([book.opened, book.loaded.navigation]);
        if (!active || !hostRef.current || !book.isOpen) return;

        onToc(navigation.toc);
        rendition = book.renderTo(hostRef.current, { width: '100%', height: '100%' });
        onRendition(rendition);
        // Deliberately do not call display here. The document controller waits
        // for the authoritative plan, resolves its stable locator to one CFI,
        // and owns the single startup display command.
      })
      .catch((error) => {
        if (!active) return;
        onError?.(error instanceof Error ? error : new Error('Failed to render EPUB'));
      });

    return () => {
      active = false;
      try {
        rendition?.destroy();
      } catch {
        // The book teardown below is the final ownership boundary.
      }
      try {
        book?.destroy();
      } catch {
        // Already closed renditions are safe to discard.
      }
    };
  }, [attempt, data, onError, onRendition, onToc]);

  return <div ref={hostRef} className="h-full w-full" />;
}

export function EPUBViewer({ className = '', epubState, onError }: EPUBViewerProps) {
  const [isTocOpen, setIsTocOpen] = useState(false);
  const {
    currDocData,
    currDocPage,
    currDocPages,
    renditionAttempt,
    renderedTextRevision,
    handleLocationChanged,
    bookRef,
    renditionRef,
    tocRef,
    setRendition,
    refreshRenderedPlacement,
    highlightSegment,
    clearHighlights,
    highlightWordIndex,
    clearWordHighlights,
  } = epubState;
  const {
    registerLocationChangeHandler,
    pause,
    currentSegment,
    currentSentenceAlignment,
    currentWordIndex
  } = useTTS();
  const { epubTheme, epubHighlightEnabled, epubWordHighlightEnabled } = useConfig();
  const [activeRendition, setActiveRendition] = useState<Rendition>();
  useEPUBTheme(epubTheme, activeRendition);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isResizing, setIsResizing, dimensions } = useEPUBResize(containerRef);

  const handleRendition = useCallback((rendition: Rendition) => {
    setActiveRendition(rendition);
    setRendition(rendition);
  }, [setRendition]);

  const handleToc = useCallback((toc: NavItem[]) => {
    tocRef.current = toc;
  }, [tocRef]);

  const checkResize = useCallback(() => {
    if (isResizing && dimensions && bookRef.current?.isOpen && renditionRef.current) {
      pause();
      void refreshRenderedPlacement(true);
      setIsResizing(false);

      return true;
    } else {
      return false;
    }
  }, [isResizing, setIsResizing, dimensions, pause, bookRef, renditionRef, refreshRenderedPlacement]);

  // Check for isResizing to pause TTS and re-extract text
  useEffect(() => {
    if (checkResize()) return;
  }, [checkResize]);

  // Register the location change handler
  useEffect(() => {
    registerLocationChangeHandler(handleLocationChanged);
    return () => {
      registerLocationChangeHandler(null);
    };
  }, [
    registerLocationChangeHandler,
    handleLocationChanged,
  ]);

  // Handle highlighting
  useLayoutEffect(() => {
    if (currentSegment) {
      if (!highlightSegment(currentSegment)) {
        onError?.(new Error('The selected worker-plan segment did not map to the rendered EPUB.'));
      }
    } else {
      clearHighlights();
    }
  }, [currentSegment, renderedTextRevision, highlightSegment, clearHighlights, onError]);

  // Word-level highlight layered on top of the block highlight
  useEffect(() => {
    if (!epubHighlightEnabled || !epubWordHighlightEnabled) {
      clearWordHighlights();
      return;
    }

    if (currentWordIndex === null || currentWordIndex === undefined || currentWordIndex < 0) {
      clearWordHighlights();
      return;
    }

    if (!currentSentenceAlignment) {
      clearWordHighlights();
      return;
    }

    highlightWordIndex(
      currentSentenceAlignment,
      currentWordIndex,
      currentSegment
    );
  }, [
    currentWordIndex,
    currentSegment,
    currentSentenceAlignment,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
    clearWordHighlights,
    highlightWordIndex
  ]);

  if (!currDocData) return null;

  return (
    <div className={`h-full flex flex-col relative z-0 ${className}`} ref={containerRef}>
      <div className="flex items-center justify-between px-2 py-1 border-b border-line-soft bg-surface text-xs text-soft">
        <div className="flex items-center gap-2">
          <ToolbarButton
            type="button"
            onClick={() => setIsTocOpen(open => !open)}
            aria-label={isTocOpen ? 'Hide chapters' : 'Show chapters'}
            className="px-1"
          >
            <DotsVerticalIcon className="w-4 h-4" />
          </ToolbarButton>
          <ToolbarButton
            type="button"
            onClick={() => handleLocationChanged('prev')}
            aria-label="Previous section"
          >
            <ChevronLeftIcon className="w-4 h-4" />
          </ToolbarButton>
        </div>
        {currDocPages !== undefined && typeof currDocPage === 'number' && (
          <span className="px-2 tabular-nums">
            {currDocPage} / {currDocPages}
          </span>
        )}
        <ToolbarButton
          type="button"
          onClick={() => handleLocationChanged('next')}
          aria-label="Next section"
        >
          <ChevronRightIcon className="w-4 h-4" />
        </ToolbarButton>
      </div>
      {isTocOpen && tocRef.current && tocRef.current.length > 0 && (
        <div className="border-b border-line-soft bg-background text-xs overflow-y-auto max-h-64 p-2">
          <div className="font-semibold text-soft pb-1">Skip to chapters</div>
          <div className="flex flex-wrap gap-1 w-full">
            {tocRef.current.map((item, index) => (
              <button
                key={`${item.href}-${index}`}
                type="button"
                onClick={() => {
                  if (item.href) handleLocationChanged(item.href);
                  setIsTocOpen(false);
                }}
                className="
                  px-2 py-1 rounded-md font-medium text-foreground text-center bg-surface
                  hover:bg-accent-wash hover:text-accent transition-colors duration-fast
                  whitespace-nowrap
                  flex-1 min-w-[140px]
                "
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <EpubRenditionHost
          data={currDocData}
          attempt={renditionAttempt}
          onError={onError}
          onRendition={handleRendition}
          onToc={handleToc}
        />
      </div>
    </div>
  );
}
