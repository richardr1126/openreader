'use client';

import { memo, useEffect, useMemo, useRef } from 'react';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import { useTTS, useTTSHighlight } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { locateAlignmentWordSpans } from '@/lib/client/highlight-token-alignment';
import { createTapGuard } from '@/lib/client/reader/segment-hit';

type PlanTextReaderType = 'pdf' | 'epub';

interface PlanTextViewerProps {
  readerType: PlanTextReaderType;
  className?: string;
  onReady?: () => void;
}

type Paragraph = { key: string; segments: CanonicalTtsSegment[] };

/**
 * Paragraphs of the playback plan. PDF sentences regroup by the parsed block
 * they were read from; EPUB resources are whole chapters, so each sentence is
 * its own line, as in the iOS reader.
 */
function paragraphsOf(segments: readonly CanonicalTtsSegment[], readerType: PlanTextReaderType): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const segment of segments) {
    const locator = segment.ownerLocator;
    const owner = readerType === 'pdf' && locator?.readerType === 'pdf'
      ? `${locator.page}:${locator.blockId}`
      : `s:${segment.ordinal}`;
    const last = paragraphs[paragraphs.length - 1];
    if (last && last.key === owner) last.segments.push(segment);
    else paragraphs.push({ key: owner, segments: [segment] });
  }
  return paragraphs;
}

const Sentence = memo(function Sentence({
  segment,
  isCurrent,
  showSentence,
  word,
}: {
  segment: CanonicalTtsSegment;
  isCurrent: boolean;
  showSentence: boolean;
  word: { start: number; end: number } | null;
}) {
  const className = [
    'openreader-plan-sentence',
    isCurrent && showSentence ? 'openreader-html-highlight-sentence' : '',
  ].filter(Boolean).join(' ');
  const text = segment.text;
  return (
    <>
      <span
        data-ordinal={segment.ordinal}
        aria-current={isCurrent ? 'true' : undefined}
        className={className}
      >
        {word ? (
          <>
            {text.slice(0, word.start)}
            <span className="openreader-html-highlight-word">{text.slice(word.start, word.end)}</span>
            {text.slice(word.end)}
          </>
        ) : text}
      </span>{' '}
    </>
  );
});

/**
 * The plain-text reading mode for PDF and EPUB: the playback plan rendered as
 * flowing text. Every sentence is a plan segment, so highlighting reads the
 * selected ordinal and the spoken-word index directly, and tapping a sentence
 * is the same seek as the reader's other sentence navigation.
 */
export function PlanTextViewer({ readerType, className = '', onReady }: PlanTextViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const guardRef = useRef(createTapGuard());
  const readyRef = useRef(false);
  const {
    playbackSegments,
    playbackPlanReady,
    resolvedLanguage,
    skipToOrdinal,
  } = useTTS();
  const { currentSegment, currentSentenceAlignment, currentWordIndex } = useTTSHighlight();
  const config = useConfig();
  const sentenceEnabled = readerType === 'pdf' ? config.pdfHighlightEnabled : config.epubHighlightEnabled;
  const wordEnabled = sentenceEnabled
    && (readerType === 'pdf' ? config.pdfWordHighlightEnabled : config.epubWordHighlightEnabled);

  const paragraphs = useMemo(() => paragraphsOf(playbackSegments, readerType), [playbackSegments, readerType]);
  const currentOrdinal = currentSegment?.ordinal ?? null;

  const wordSpans = useMemo(() => {
    if (!wordEnabled || !currentSegment || !currentSentenceAlignment?.words?.length) return null;
    return locateAlignmentWordSpans(currentSentenceAlignment.words, currentSegment.text, resolvedLanguage);
  }, [currentSegment, currentSentenceAlignment, resolvedLanguage, wordEnabled]);
  const currentWord = wordSpans && typeof currentWordIndex === 'number' && currentWordIndex >= 0
    ? wordSpans[currentWordIndex] ?? null
    : null;

  useEffect(() => {
    if (!playbackPlanReady || readyRef.current) return;
    readyRef.current = true;
    onReady?.();
  }, [onReady, playbackPlanReady]);

  // Follow the playback cursor: bring the selected sentence into view when it
  // leaves the viewport, without fighting a reader who scrolled within view.
  useEffect(() => {
    if (currentOrdinal === null) return;
    const scroller = scrollRef.current;
    const element = scroller?.querySelector<HTMLElement>(`[data-ordinal="${currentOrdinal}"]`);
    if (!scroller || !element) return;
    const view = scroller.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (rect.top < view.top || rect.bottom > view.bottom) {
      element.scrollIntoView({ block: 'center' });
    }
  }, [currentOrdinal, paragraphs]);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        data-testid="plan-text-reader"
        onPointerDown={(event) => guardRef.current.pointerDown(event)}
        onClick={(event) => {
          if (!guardRef.current.isTap(event.nativeEvent)) return;
          const sentence = (event.target as Element).closest?.('[data-ordinal]');
          const ordinal = Number(sentence?.getAttribute('data-ordinal'));
          if (sentence && Number.isFinite(ordinal)) skipToOrdinal(ordinal);
        }}
      >
        <article className="prose prose-base mx-auto max-w-3xl px-4 py-6">
          {paragraphs.map((paragraph) => (
            <p key={paragraph.key}>
              {paragraph.segments.map((segment) => {
                const isCurrent = segment.ordinal === currentOrdinal;
                return (
                  <Sentence
                    key={segment.ordinal}
                    segment={segment}
                    isCurrent={isCurrent}
                    showSentence={sentenceEnabled}
                    word={isCurrent ? currentWord : null}
                  />
                );
              })}
            </p>
          ))}
        </article>
      </div>
    </div>
  );
}
