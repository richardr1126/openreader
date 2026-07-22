'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import type { HtmlBlock } from '@openreader/tts/html-blocks';
import {
  clearHtmlSentenceHighlight,
  clearHtmlWordHighlight,
  highlightHtmlSentence,
  highlightHtmlWord,
  scrollSentenceIntoView,
} from '@/lib/client/html/highlight';

interface HTMLViewerProps {
  className?: string;
  blocks: HtmlBlock[];
  isTxt: boolean;
  onReady?: () => void;
  onError?: (error: Error) => void;
}

export function HTMLViewer({
  className = '',
  blocks,
  isTxt,
  onReady,
  onError,
}: HTMLViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const {
    currentSentence,
    currentSentenceAlignment,
    currentWordIndex,
    resolvedLanguage,
    playbackPlanLifecycle,
    playbackPlanSegmentCount,
  } = useTTS();
  const { htmlHighlightEnabled, htmlWordHighlightEnabled } = useConfig();

  const readySegmentRef = useRef<string | null>(null);

  // A surface commit is synchronous: React has committed the blocks, the
  // worker plan has committed a selection, and this layout effect applies that
  // selection before the reader is revealed. Missing canonical text is an
  // explicit render failure, not a timer-driven retry branch.
  useLayoutEffect(() => {
    if (playbackPlanLifecycle.status !== 'ready') return;
    if (playbackPlanSegmentCount === 0) {
      clearHtmlSentenceHighlight();
      if (readySegmentRef.current !== 'empty') {
        readySegmentRef.current = 'empty';
        onReady?.();
      }
      return;
    }
    if (!currentSentence) return;
    const container = contentRef.current;
    if (!container) return;
    clearHtmlSentenceHighlight();
    if (htmlHighlightEnabled && !highlightHtmlSentence(container, currentSentence, resolvedLanguage)) {
      onError?.(new Error('The selected worker-plan segment did not map to the rendered HTML.'));
      return;
    }
    if (htmlHighlightEnabled) scrollSentenceIntoView(scrollRef.current);
    if (readySegmentRef.current !== currentSentence) {
      readySegmentRef.current = currentSentence;
      onReady?.();
    }
  }, [
    blocks,
    htmlHighlightEnabled,
    currentSentence,
    resolvedLanguage,
    playbackPlanLifecycle.status,
    playbackPlanSegmentCount,
    onError,
    onReady,
  ]);

  // Word highlight is layered inside the current sentence wrap. Same
  // scheduling pattern as the sentence effect.
  useLayoutEffect(() => {
    if (!htmlHighlightEnabled || !htmlWordHighlightEnabled) {
      clearHtmlWordHighlight();
      return;
    }
    if (
      !currentSentenceAlignment ||
      currentWordIndex === null ||
      currentWordIndex === undefined ||
      currentWordIndex < 0
    ) {
      clearHtmlWordHighlight();
      return;
    }
    const container = contentRef.current;
    if (!container) return;
    highlightHtmlWord(container, currentSentenceAlignment, currentWordIndex);
  }, [
    htmlHighlightEnabled,
    htmlWordHighlightEnabled,
    currentSentenceAlignment,
    currentWordIndex,
  ]);

  // Real cleanup on unmount — clear timeouts and tear down any leftover
  // wraps. The empty deps ensure this only fires when HTMLViewer itself
  // unmounts (route change, etc.), not on every prop/context update.
  useEffect(() => {
    return () => {
      clearHtmlSentenceHighlight();
      clearHtmlWordHighlight();
    };
  }, []);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div
          ref={contentRef}
          className={`html-container min-w-full px-4 py-4 ${isTxt ? 'font-mono text-sm' : 'prose prose-base'}`}
        >
          {blocks.map((block) => (
            <div
              key={block.anchorId}
              id={block.anchorId}
              data-block-kind={block.kind}
              className="openreader-html-block"
            >
              {isTxt ? (
                <pre className="whitespace-pre-wrap font-mono text-sm m-0">{block.raw}</pre>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.raw}</ReactMarkdown>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
