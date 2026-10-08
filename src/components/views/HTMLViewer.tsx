'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTTS, useTTSHighlight } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import type { HtmlBlock } from '@openreader/tts/html-blocks';
import {
  clearHtmlSentenceHighlight,
  clearHtmlWordHighlight,
  highlightHtmlSentence,
  highlightHtmlWord,
  scrollSentenceIntoView,
} from '@/lib/client/html/highlight';
import { indexSegmentsBySource, resolvePointInUnit, segmentSourceKey } from '@/lib/client/reader/segment-hit';
import { bindTapToSeek } from '@/lib/client/reader/tap-to-seek';
import { buildPlanTextBlocks } from '@/lib/client/reader/plan-text-blocks';
import { useLatestRef } from '@/hooks/useLatestRef';
import type { ReaderType } from '@/types/user-state';

/**
 * How a block is rendered: `markdown` for .md and imported web articles
 * (headings, lists, images), `text` for .txt and the PDF/EPUB plain-text mode,
 * where every character stays literal.
 */
export type TextBlockFormat = 'markdown' | 'text';

interface HTMLViewerProps {
  className?: string;
  blocks: HtmlBlock[];
  format: TextBlockFormat;
  /** Whose highlight settings apply: the text reader or the PDF/EPUB plain-text mode. */
  readerType?: ReaderType;
  onReady?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Remount the rendered blocks when the block list is replaced (a new plan in
 * plain-text mode): highlight wraps split the text nodes React rendered, so a
 * replaced list must not be reconciled into them.
 */
const blockListIds = new WeakMap<readonly HtmlBlock[], number>();
let nextBlockListId = 0;
function blockListId(blocks: readonly HtmlBlock[]): number {
  let id = blockListIds.get(blocks);
  if (id === undefined) {
    nextBlockListId += 1;
    id = nextBlockListId;
    blockListIds.set(blocks, id);
  }
  return id;
}

/**
 * The one text reader: Markdown, TXT, and PDF/EPUB with page layout off. Each
 * block is a plan source unit keyed by its anchor id, so sentence and word
 * highlight, tap-to-seek and auto-scroll resolve segments the same way for
 * every format.
 */
export function HTMLViewer({
  className = '',
  blocks,
  format,
  readerType = 'html',
  onReady,
  onError,
}: HTMLViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const {
    resolvedLanguage,
    playbackPlanReady,
    playbackPlanSegmentCount,
    playbackSegments,
    skipToOrdinal,
  } = useTTS();
  const {
    currentSegment,
    currentSentence,
    currentSentenceAlignment,
    currentWordIndex,
  } = useTTSHighlight();
  const config = useConfig();
  const highlightEnabled = readerType === 'pdf'
    ? config.pdfHighlightEnabled
    : readerType === 'epub' ? config.epubHighlightEnabled : config.htmlHighlightEnabled;
  const wordHighlightEnabled = highlightEnabled && (readerType === 'pdf'
    ? config.pdfWordHighlightEnabled
    : readerType === 'epub' ? config.epubWordHighlightEnabled : config.htmlWordHighlightEnabled);

  const readySegmentRef = useRef<string | null>(null);

  // Tap a sentence to play from it. A tap resolves within its block's own
  // sentences, keyed exactly as the blocks' anchor ids.
  const segmentsByBlock = useMemo(() => indexSegmentsBySource(playbackSegments), [playbackSegments]);
  const tapStateRef = useLatestRef({ segmentsByBlock, resolvedLanguage, skipToOrdinal });
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    return bindTapToSeek(container, {
      resolve: (point) => {
        const target = point.target as Element | null;
        const block = target?.closest?.('.openreader-html-block');
        if (!block || !container.contains(block)) return null;
        const { segmentsByBlock: index, resolvedLanguage: language } = tapStateRef.current;
        return resolvePointInUnit([block], index.get(block.id) ?? [], point, language);
      },
      seek: (ordinal) => {
        tapStateRef.current.skipToOrdinal(ordinal);
      },
    });
  }, [tapStateRef]);

  // A surface commit is synchronous: React has committed the blocks, the
  // worker plan has committed a selection, and this layout effect applies that
  // selection before the reader is revealed. Missing canonical text is an
  // explicit render failure, not a timer-driven retry branch.
  const currentBlockKey = currentSegment ? segmentSourceKey(currentSegment) : null;
  useLayoutEffect(() => {
    if (!playbackPlanReady) return;
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
    if (highlightEnabled) {
      // The owning block, plus the next one a sentence may run on into.
      const owner = currentBlockKey ? container.ownerDocument.getElementById(currentBlockKey) : null;
      const scope = owner && container.contains(owner)
        ? [owner, owner.nextElementSibling].filter((element): element is HTMLElement => element instanceof HTMLElement)
        : [];
      if (!highlightHtmlSentence(container, currentSentence, resolvedLanguage, scope)) {
        onError?.(new Error('The selected worker-plan segment did not map to the rendered text.'));
        return;
      }
      scrollSentenceIntoView(scrollRef.current);
    }
    if (readySegmentRef.current !== currentSentence) {
      readySegmentRef.current = currentSentence;
      onReady?.();
    }
  }, [
    blocks,
    highlightEnabled,
    currentBlockKey,
    currentSentence,
    resolvedLanguage,
    playbackPlanReady,
    playbackPlanSegmentCount,
    onError,
    onReady,
  ]);

  // Word highlight is layered inside the current sentence wrap. Same
  // scheduling pattern as the sentence effect.
  useLayoutEffect(() => {
    if (!wordHighlightEnabled) {
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
    wordHighlightEnabled,
    currentSentenceAlignment,
    currentWordIndex,
  ]);

  // Real cleanup on unmount — tear down any leftover wraps. The empty deps
  // ensure this only fires when HTMLViewer itself unmounts (route change,
  // layout toggle), not on every prop/context update.
  useEffect(() => {
    return () => {
      clearHtmlSentenceHighlight();
      clearHtmlWordHighlight();
    };
  }, []);

  // Rendered once per block list: highlight and word updates re-render this
  // component often and must not re-render a whole book.
  const renderedBlocks = useMemo(() => (
    <div key={blockListId(blocks)}>
      {blocks.map((block) => (
        <div
          key={block.anchorId}
          id={block.anchorId}
          data-block-kind={block.kind}
          className="openreader-html-block"
        >
          {format === 'markdown' ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.raw}</ReactMarkdown>
          ) : (
            <p>{block.plainText}</p>
          )}
        </div>
      ))}
    </div>
  ), [blocks, format]);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div ref={scrollRef} className="flex-1 overflow-auto" data-testid="text-reader">
        <div
          ref={contentRef}
          className="html-container prose prose-base min-w-full px-4 py-4"
        >
          {renderedBlocks}
        </div>
      </div>
    </div>
  );
}

/**
 * PDF and EPUB with page layout off: the playback plan read in the text
 * reader, as iOS does for every format without layout.
 */
export function PlanTextReader({
  readerType,
  className,
  onReady,
  onError,
}: {
  readerType: 'pdf' | 'epub';
  className?: string;
  onReady?: () => void;
  onError?: (error: Error) => void;
}) {
  const { playbackSegments } = useTTS();
  const blocks = useMemo(() => buildPlanTextBlocks(playbackSegments), [playbackSegments]);
  return (
    <HTMLViewer
      className={className}
      blocks={blocks}
      format="text"
      readerType={readerType}
      onReady={onReady}
      onError={onError}
    />
  );
}
