'use client';

import { useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import type { HtmlBlock } from '@/lib/client/html/blocks';
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
  isLoading?: boolean;
}

export function HTMLViewer({
  className = '',
  blocks,
  isTxt,
  isLoading = false,
}: HTMLViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const {
    currentSentence,
    currentSentenceAlignment,
    currentWordIndex,
    resolvedLanguage,
  } = useTTS();
  const { htmlHighlightEnabled, htmlWordHighlightEnabled } = useConfig();

  // ---- Sentence highlight scheduling -------------------------------------
  // Mirrors PDFViewer: schedule + retry via setTimeout, with a sequence
  // counter so stale retries from a previous sentence are aborted as soon as
  // the user (or TTS) moves on. The cleanup only cancels pending timeouts —
  // it does NOT clear the wrap. Wrap removal happens at the top of the next
  // effect run, which keeps Strict Mode's mount→unmount→mount cycle from
  // wiping the very first highlight.
  const sentenceSeqRef = useRef(0);
  const sentenceTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const wordSeqRef = useRef(0);
  const wordTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearSentenceTimeouts = useCallback(() => {
    for (const t of sentenceTimeoutsRef.current) clearTimeout(t);
    sentenceTimeoutsRef.current = [];
  }, []);
  const scheduleSentence = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    sentenceTimeoutsRef.current.push(t);
  }, []);
  const clearWordTimeouts = useCallback(() => {
    for (const t of wordTimeoutsRef.current) clearTimeout(t);
    wordTimeoutsRef.current = [];
  }, []);
  const scheduleWord = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    wordTimeoutsRef.current.push(t);
  }, []);

  // Sentence highlight.
  // The `blocks` dep ensures we re-attempt when ReactMarkdown rerenders for
  // a new document (so the FIRST sentence after load gets a fresh tokenize).
  useEffect(() => {
    clearSentenceTimeouts();

    if (!htmlHighlightEnabled || !currentSentence) {
      // Invalidate any in-flight retries from a previous sentence and wipe
      // whatever wrap is currently on screen — there's nothing valid to draw.
      sentenceSeqRef.current += 1;
      clearHtmlSentenceHighlight();
      return;
    }

    // New highlight pass — bump the sequence so any retries still pending
    // from a previous sentence short-circuit before touching the DOM.
    const seq = ++sentenceSeqRef.current;

    const tryApply = (attempt: number) => {
      if (seq !== sentenceSeqRef.current) return;
      const container = contentRef.current;
      if (!container) {
        if (attempt < 10) scheduleSentence(() => tryApply(attempt + 1), 75);
        return;
      }
      // Clear any prior wrap right before we try to apply a new one. Doing it
      // here (not in cleanup) avoids a Strict-Mode-induced wipe of the very
      // first highlight.
      clearHtmlSentenceHighlight();
      const matched = highlightHtmlSentence(container, currentSentence, resolvedLanguage);
      if (matched) {
        scrollSentenceIntoView(scrollRef.current);
        return;
      }
      // DOM tokens couldn't satisfy the sentence yet (rare — async font load,
      // late ReactMarkdown commit, etc.). Try again shortly.
      if (attempt < 10) {
        scheduleSentence(() => tryApply(attempt + 1), 75);
      }
    };

    // Small initial defer so React's commit + browser layout finish before
    // we walk the DOM. Matches the cadence PDFViewer uses.
    scheduleSentence(() => tryApply(0), 30);

    return () => {
      clearSentenceTimeouts();
    };
  }, [
    htmlHighlightEnabled,
    currentSentence,
    resolvedLanguage,
    blocks,
    clearSentenceTimeouts,
    scheduleSentence,
  ]);

  // Word highlight is layered inside the current sentence wrap. Same
  // scheduling pattern as the sentence effect.
  useEffect(() => {
    clearWordTimeouts();

    if (!htmlHighlightEnabled || !htmlWordHighlightEnabled) {
      wordSeqRef.current += 1;
      clearHtmlWordHighlight();
      return;
    }
    if (
      !currentSentenceAlignment ||
      currentWordIndex === null ||
      currentWordIndex === undefined ||
      currentWordIndex < 0
    ) {
      wordSeqRef.current += 1;
      clearHtmlWordHighlight();
      return;
    }

    const seq = ++wordSeqRef.current;

    const tryApplyWord = (attempt: number) => {
      if (seq !== wordSeqRef.current) return;
      const container = contentRef.current;
      if (!container) {
        if (attempt < 8) scheduleWord(() => tryApplyWord(attempt + 1), 60);
        return;
      }
      const ok = highlightHtmlWord(container, currentSentenceAlignment, currentWordIndex);
      if (!ok && attempt < 8) {
        // Sentence wrap may not have settled yet — retry briefly so the very
        // first word of the very first sentence isn't dropped.
        scheduleWord(() => tryApplyWord(attempt + 1), 60);
      }
    };

    tryApplyWord(0);

    return () => {
      clearWordTimeouts();
    };
  }, [
    htmlHighlightEnabled,
    htmlWordHighlightEnabled,
    currentSentenceAlignment,
    currentWordIndex,
    clearWordTimeouts,
    scheduleWord,
  ]);

  // Real cleanup on unmount — clear timeouts and tear down any leftover
  // wraps. The empty deps ensure this only fires when HTMLViewer itself
  // unmounts (route change, etc.), not on every prop/context update.
  useEffect(() => {
    return () => {
      clearSentenceTimeouts();
      clearWordTimeouts();
      clearHtmlSentenceHighlight();
      clearHtmlWordHighlight();
    };
  }, [clearSentenceTimeouts, clearWordTimeouts]);

  if (isLoading || !blocks.length) {
    return <DocumentSkeleton />;
  }

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
