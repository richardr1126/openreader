'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { useEPUB } from '@/contexts/EPUBContext';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { useEPUBTheme, getThemeStyles } from '@/hooks/epub/useEPUBTheme';
import { useEPUBResize } from '@/hooks/epub/useEPUBResize';
import { DotsVerticalIcon, ChevronLeftIcon, ChevronRightIcon } from '@/components/icons/Icons';

const ReactReader = dynamic(() => import('react-reader').then(mod => mod.ReactReader), {
  ssr: false,
  loading: () => <DocumentSkeleton />
});

interface EPUBViewerProps {
  className?: string;
}

export function EPUBViewer({ className = '' }: EPUBViewerProps) {
  const [isTocOpen, setIsTocOpen] = useState(false);
  const {
    currDocData,
    currDocName,
    currDocPage,
    currDocPages,
    locationRef,
    handleLocationChanged,
    bookRef,
    renditionRef,
    tocRef,
    setRendition,
    extractPageText,
    highlightPattern,
    clearHighlights,
    highlightWordIndex,
    clearWordHighlights
  } = useEPUB();
  const {
    registerLocationChangeHandler,
    pause,
    currentSentence,
    currentSentenceAlignment,
    currentWordIndex
  } = useTTS();
  const { epubTheme, epubHighlightEnabled, epubWordHighlightEnabled } = useConfig();
  const { updateTheme } = useEPUBTheme(epubTheme, renditionRef.current);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isResizing, setIsResizing, dimensions } = useEPUBResize(containerRef);

  const checkResize = useCallback(() => {
    if (isResizing && dimensions && bookRef.current?.isOpen && renditionRef.current) {
      pause();
      // Only extract text when we have dimensions, ensuring the resize is complete
      extractPageText(bookRef.current, renditionRef.current, true);
      setIsResizing(false);

      return true;
    } else {
      return false;
    }
  }, [isResizing, setIsResizing, dimensions, pause, bookRef, renditionRef, extractPageText]);

  // Check for isResizing to pause TTS and re-extract text
  useEffect(() => {
    if (checkResize()) return;
  }, [checkResize]);

  // Register the location change handler
  useEffect(() => {
    registerLocationChangeHandler(handleLocationChanged);
  }, [registerLocationChangeHandler, handleLocationChanged]);

  // Handle highlighting
  useEffect(() => {
    if (currentSentence) {
      highlightPattern(currentSentence);
    } else {
      clearHighlights();
    }
  }, [currentSentence, highlightPattern, clearHighlights]);

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
      currentSentence || ''
    );
  }, [
    currentWordIndex,
    currentSentence,
    currentSentenceAlignment,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
    clearWordHighlights,
    highlightWordIndex
  ]);

  if (!currDocData) {
    return <DocumentSkeleton />;
  }

  return (
    <div className={`h-full flex flex-col relative z-0 ${className}`} ref={containerRef}>
      <div className="flex items-center justify-between px-2 py-1 border-b border-offbase bg-base text-xs text-muted">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsTocOpen(open => !open)}
            className="inline-flex items-center py-1 px-1 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out transform hover:scale-[1.09] hover:text-accent"
            aria-label={isTocOpen ? 'Hide chapters' : 'Show chapters'}
          >
            <DotsVerticalIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => renditionRef.current?.prev()}
            className="inline-flex items-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out transform hover:scale-[1.09] hover:text-accent"
            aria-label="Previous section"
          >
            <ChevronLeftIcon className="w-4 h-4" />
          </button>
        </div>
        {currDocPages !== undefined && typeof currDocPage === 'number' && (
          <span className="px-2 tabular-nums">
            {currDocPage} / {currDocPages}
          </span>
        )}
        <button
          type="button"
          onClick={() => renditionRef.current?.next()}
          className="inline-flex items-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out transform hover:scale-[1.09] hover:text-accent"
          aria-label="Next section"
        >
          <ChevronRightIcon className="w-4 h-4" />
        </button>
      </div>
      {isTocOpen && tocRef.current && tocRef.current.length > 0 && (
        <div className="border-b border-offbase bg-background text-xs overflow-y-auto max-h-64 p-2">
          <div className="font-semibold text-muted pb-1">Skip to chapters</div>
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
                  px-2 py-1 rounded-md font-medium text-foreground text-center bg-base 
                  hover:bg-offbase hover:text-accent transition-colors duration-150
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
        <ReactReader
          loadingView={<DocumentSkeleton />}
          key={'epub-reader'}
          location={locationRef.current}
          locationChanged={handleLocationChanged}
          url={currDocData}
          title={currDocName}
          tocChanged={(_toc) => (tocRef.current = _toc)}
          showToc={false}
          readerStyles={getThemeStyles(epubTheme)}
          getRendition={(_rendition) => {
            setRendition(_rendition);
            updateTheme();
          }}
        />
      </div>
    </div>
  );
}
