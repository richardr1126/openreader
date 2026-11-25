'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTTS, useTTSHighlight } from '@/contexts/TTSContext';
import { useReaderAppearance } from '@/contexts/ReaderAppearanceContext';
import { useConfig } from '@/contexts/ConfigContext';
import { ImageIcon } from '@/components/icons/Icons';
import { Button } from '@/components/ui';
import toast from 'react-hot-toast';
import { READER_FONT_FAMILIES } from '@/lib/shared/reader-appearance';
import type { HtmlBlock } from '@openreader/tts/html-blocks';
import {
  clearHtmlSentenceHighlight,
  clearHtmlWordHighlight,
  highlightHtmlSentence,
  highlightHtmlWord,
  scrollSentenceIntoView,
} from '@/lib/client/html/highlight';
import {
  indexSegmentsBySource,
  resolvePointInUnit,
  resolveSelectionInUnits,
  segmentSourceKey,
} from '@/lib/client/reader/segment-hit';
import { paintSavedHighlights } from '@/lib/client/reader/saved-highlights';
import { bindSelectionReporting, useReaderHighlights } from '@/components/reader/ReaderHighlights';
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

// Fetching an image from another origin tells its host the document was
// opened, so those stay hidden until the reader loads them for this document or
// always loads them. Same-origin images reach only this app.
// A hidden image leaves an empty marker, so the parser that renders the text
// also decides whether there are images to offer, and no text node shifts.
function isRemoteImage(src: string | undefined): boolean {
  if (!src) return false;
  try {
    return new URL(src, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}
function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" />;
}
const HIDDEN_IMAGES: Components = {
  img: ({ src, alt, title }) => isRemoteImage(typeof src === 'string' ? src : undefined)
    ? <span data-hidden-image hidden />
    : <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} title={title} />,
};
const REMOTE_IMAGES: Components = {
  img: ({ src, alt, title }) => <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} title={title} />,
};

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
    followingNarration,
    setFollowingNarration,
    readerNavigationRevision,
  } = useTTS();
  const {
    currentSegment,
    currentSentence,
    currentSentenceAlignment,
    currentWordIndex,
  } = useTTSHighlight();
  const { presentation: { highlightSegment: highlightEnabled, highlightWords: wordHighlightEnabled } } = useReaderAppearance(readerType);

  const readySegmentRef = useRef<string | null>(null);

  const { loadRemoteImages, updateConfig } = useConfig();
  // The block list loaded for this document, once its images were allowed.
  const [imagesAllowedFor, setImagesAllowedFor] = useState<readonly HtmlBlock[] | null>(null);
  const showImages = format === 'markdown' && (loadRemoteImages || imagesAllowedFor === blocks);
  const [hasHiddenImages, setHasHiddenImages] = useState(false);

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
    {
      // The owning block, plus the next one a sentence may run on into.
      const owner = currentBlockKey ? container.ownerDocument.getElementById(currentBlockKey) : null;
      const scope = owner && container.contains(owner)
        ? [owner, owner.nextElementSibling].filter((element): element is HTMLElement => element instanceof HTMLElement)
        : [];
      if (!highlightHtmlSentence(container, currentSentence, resolvedLanguage, scope, highlightEnabled)) {
        onError?.(new Error('The selected worker-plan segment did not map to the rendered text.'));
        return;
      }
      if (followingNarration || readySegmentRef.current === null) scrollSentenceIntoView(scrollRef.current);
    }
    if (readySegmentRef.current !== currentSentence) {
      readySegmentRef.current = currentSentence;
      onReady?.();
    }
  }, [
    blocks,
    showImages,
    followingNarration,
    readerNavigationRevision,
    highlightEnabled,
    wordHighlightEnabled,
    currentBlockKey,
    currentSentence,
    resolvedLanguage,
    playbackPlanReady,
    playbackPlanSegmentCount,
    onError,
    onReady,
  ]);

  // Word paint uses the prepared segment region even when segment paint is off.
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
    blocks,
    showImages,
    // The sentence effect rebuilds the region (and clears the word) on these.
    followingNarration,
    readerNavigationRevision,
    highlightEnabled,
    wordHighlightEnabled,
    currentBlockKey,
    currentSentence,
    resolvedLanguage,
    playbackPlanReady,
    playbackPlanSegmentCount,
    onError,
    onReady,
    currentSentenceAlignment,
    currentWordIndex,
  ]);

  // Saved highlights paint after the sentence and word wraps above, which
  // split and rejoin the text nodes their ranges sit on.
  const { highlights: savedHighlights, declarations: savedDeclarations, reportSelection } = useReaderHighlights();
  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const units = function* () {
      for (const [key, candidates] of segmentsByBlock) {
        const block = container.ownerDocument.getElementById(key);
        if (block && container.contains(block)) yield { roots: [block], candidates };
      }
    };
    paintSavedHighlights(container.ownerDocument, units(), savedHighlights, savedDeclarations, resolvedLanguage);
  }, [
    blocks,
    showImages,
    followingNarration,
    readerNavigationRevision,
    highlightEnabled,
    wordHighlightEnabled,
    currentSentence,
    currentSentenceAlignment,
    currentWordIndex,
    resolvedLanguage,
    segmentsByBlock,
    savedHighlights,
    savedDeclarations,
  ]);

  // A selection over the text offers to highlight the sentences it covers.
  const selectionStateRef = useLatestRef({ segmentsByBlock, resolvedLanguage });
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    return bindSelectionReporting(container.ownerDocument, (range) => {
      if (!container.contains(range.commonAncestorContainer)) return null;
      const { segmentsByBlock: index, resolvedLanguage: language } = selectionStateRef.current;
      const units = Array.from(container.querySelectorAll<HTMLElement>('.openreader-html-block'));
      return resolveSelectionInUnits(range, units, (unit) => [unit], (unit) => index.get(unit.id) ?? [], language);
    }, reportSelection);
  }, [reportSelection, selectionStateRef]);

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
  const { typography } = useReaderAppearance();
  const renderedBlocks = useMemo(() => (
    <div key={`${blockListId(blocks)}:${showImages}`}>
      {blocks.map((block) => (
        <div
          key={block.anchorId}
          id={block.anchorId}
          data-block-kind={block.kind}
          className="openreader-html-block"
        >
          {format === 'markdown' ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={showImages ? REMOTE_IMAGES : HIDDEN_IMAGES}>{block.raw}</ReactMarkdown>
          ) : (
            <p>{block.plainText}</p>
          )}
        </div>
      ))}
    </div>
  ), [blocks, format, showImages]);
  useLayoutEffect(() => {
    setHasHiddenImages(Boolean(contentRef.current?.querySelector('[data-hidden-image]')));
  }, [renderedBlocks]);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {hasHiddenImages && (
        <div role="group" aria-label="Remote images" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-soft bg-surface-sunken px-4 py-2 text-xs text-soft">
          <ImageIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="m-0 min-w-0 flex-1">
            <span className="font-medium text-foreground">Images hidden.</span>{' '}
            Loading them tells their host that you opened this document.
          </p>
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => {
              setImagesAllowedFor(blocks);
              void updateConfig({ loadRemoteImages: true }).catch(() => {
                toast.error('Could not save. Images load for this document only.');
              });
            }}>Always load</Button>
            <Button size="xs" variant="outline" onClick={() => setImagesAllowedFor(blocks)}>Load images</Button>
          </div>
        </div>
      )}
      <div ref={scrollRef} tabIndex={0} role="region" aria-label="Document text" className="flex-1 overflow-auto" data-testid="text-reader"
        onWheel={() => setFollowingNarration(false)}
        onTouchMove={() => setFollowingNarration(false)}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) setFollowingNarration(false);
        }}>
        <div
          ref={contentRef}
          className="html-container prose prose-base px-4 py-4 mx-auto"
          style={{
            maxWidth: 'none', width: `${typography.readingWidth}%`, minWidth: 'min(100%, 20rem)',
            fontFamily: READER_FONT_FAMILIES[typography.fontFamily] || undefined,
            fontSize: typography.sizePercent === 100 ? undefined : `${typography.sizePercent / 100}rem`,
            // This text has no publisher styles to defer to, so spacing is
            // always the chosen value, as the appearance preview draws it.
            lineHeight: typography.lineMultiplier,
            letterSpacing: typography.letterSpacing ? `${typography.letterSpacing}em` : undefined,
            textAlign: typography.alignment === 'default' ? undefined : typography.alignment,
            '--reader-paragraph-spacing': `${typography.paragraphSpacing}em`,
          } as React.CSSProperties}
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
