'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTTS } from '@/contexts/TTSContext';
import { useReaderAppearance } from '@/contexts/ReaderAppearanceContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useDocumentBookmarks } from '@/hooks/useDocumentBookmarks';
import { useHighlightKeyboardControl } from '@/hooks/audio/usePlaybackKeyboardControls';
import { highlightsOverlapping, type ResolvedHighlight } from '@/lib/client/reader/bookmarks';
import { highlightBackground } from '@/lib/shared/reader-appearance';
import { Button } from '@/components/ui';
import { HighlighterIcon } from '@/components/icons/Icons';

/** A text selection a reader resolved to whole sentences. */
export type ReaderSelection = {
  start: number;
  end: number;
  /** The selection's bounds in the top-level viewport. */
  rect: { left: number; top: number; right: number; bottom: number };
  clear: () => void;
};

/** Where a reader sends its selection. */
export type SelectionSink = {
  /** The settled selection, which places the Highlight button. */
  report: (selection: ReaderSelection | null) => void;
  /** Adds a reader of the live selection, for a key pressed before it settles. Returns the removal. */
  addSource: (read: () => ReaderSelection | null) => () => void;
};

type ReaderHighlightsValue = {
  /** Highlights placed in the current plan, in reading order. */
  highlights: readonly ResolvedHighlight[];
  /** CSS declarations for the saved highlight paint. */
  declarations: string;
  selectionSink: SelectionSink;
};

const NO_HIGHLIGHTS: ReaderHighlightsValue = {
  highlights: [],
  declarations: '',
  selectionSink: { report: () => {}, addSource: () => () => {} },
};

const ReaderHighlightsContext = createContext<ReaderHighlightsValue>(NO_HIGHLIGHTS);

export function useReaderHighlights(): ReaderHighlightsValue {
  return useContext(ReaderHighlightsContext);
}

/**
 * Saved highlights for one open document. Readers paint `highlights` and
 * report the sentences a selection covers; this owns the Highlight button
 * over a selection and the H shortcut, which highlights the selection or, with
 * none, toggles the sentence being read.
 */
export function ReaderHighlightsProvider({
  documentId,
  enabled,
  children,
}: {
  documentId: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const { highlights, highlightRange, unhighlightRange } = useDocumentBookmarks(documentId);
  const { currentSentenceOrdinal } = useTTS();
  const appearance = useReaderAppearance().highlights;
  const declarations = `background-color: ${highlightBackground(appearance, 'mark')};`;
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const { playbackShortcuts } = useConfig();

  const sourcesRef = useRef(new Set<() => ReaderSelection | null>());
  const selectionSink = useMemo<SelectionSink>(() => ({
    report: setSelection,
    addSource: (read) => {
      sourcesRef.current.add(read);
      return () => sourcesRef.current.delete(read);
    },
  }), []);
  // Only a selection entirely inside one highlight offers to remove it.
  const coveringOf = useCallback((target: ReaderSelection) => (
    highlights.find((entry) => entry.start <= target.start && entry.end >= target.end) ?? null
  ), [highlights]);
  const covering = selection ? coveringOf(selection) : null;

  const apply = useCallback((target: ReaderSelection) => {
    if (coveringOf(target)) unhighlightRange(target.start, target.end);
    else highlightRange(target.start, target.end);
    target.clear();
    setSelection(null);
  }, [coveringOf, highlightRange, unhighlightRange]);

  const toggleCurrentSentence = useCallback(() => {
    if (currentSentenceOrdinal === null) return;
    if (highlightsOverlapping(highlights, currentSentenceOrdinal, currentSentenceOrdinal).length > 0) {
      unhighlightRange(currentSentenceOrdinal, currentSentenceOrdinal);
    } else {
      highlightRange(currentSentenceOrdinal, currentSentenceOrdinal);
    }
  }, [currentSentenceOrdinal, highlightRange, highlights, unhighlightRange]);

  // The live selection, not the settled one: H can come before it settles.
  const onHighlightKey = useCallback(() => {
    for (const read of sourcesRef.current) {
      const live = read();
      if (live) return apply(live);
    }
    toggleCurrentSentence();
  }, [apply, toggleCurrentSentence]);

  useHighlightKeyboardControl({
    enabled: enabled && playbackShortcuts,
    onHighlight: onHighlightKey,
  });

  const value = useMemo(
    () => (enabled ? { highlights, declarations, selectionSink } : NO_HIGHLIGHTS),
    [declarations, enabled, highlights, selectionSink],
  );

  return (
    <ReaderHighlightsContext.Provider value={value}>
      {children}
      {enabled && selection ? (
        <SelectionAction selection={selection} removes={covering !== null} onActivate={() => apply(selection)} />
      ) : null}
    </ReaderHighlightsContext.Provider>
  );
}

function SelectionAction({
  selection,
  removes,
  onActivate,
}: {
  selection: ReaderSelection;
  removes: boolean;
  onActivate: () => void;
}) {
  const { rect } = selection;
  // Above the selection, or below it when it reaches the top of the viewport.
  const above = rect.top > 48;
  const left = Math.min(Math.max((rect.left + rect.right) / 2, 72), window.innerWidth - 72);
  return (
    <div
      className="fixed z-40"
      style={{ left, top: above ? rect.top - 8 : rect.bottom + 8, transform: `translate(-50%, ${above ? '-100%' : '0'})` }}
    >
      <Button
        size="sm"
        variant="secondary"
        className="gap-1.5 shadow-md"
        // Keep the selection: a press here must not collapse it first.
        onPointerDown={(event) => event.preventDefault()}
        onClick={onActivate}
      >
        <HighlighterIcon aria-hidden="true" className="h-3.5 w-3.5" />
        {removes ? 'Remove highlight' : 'Highlight'}
      </Button>
    </div>
  );
}

/**
 * Report the selection in `doc` to `sink` through `resolve`, which maps it to
 * whole sentences or null. `offset` moves a frame document's rects into the
 * top viewport. Returns the unbind.
 */
export function bindSelectionReporting(
  doc: Document,
  resolve: (range: Range) => { start: number; end: number } | null,
  sink: SelectionSink,
  offset?: () => { x: number; y: number },
): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reported = false;
  const read = (): ReaderSelection | null => {
    const selection = doc.getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.toString().trim()
      ? selection.getRangeAt(0)
      : null;
    const ordinals = range ? resolve(range) : null;
    if (!range || !ordinals) return null;
    const bounds = range.getBoundingClientRect();
    const { x, y } = offset?.() ?? { x: 0, y: 0 };
    return {
      ...ordinals,
      rect: { left: bounds.left + x, top: bounds.top + y, right: bounds.right + x, bottom: bounds.bottom + y },
      clear: () => selection?.removeAllRanges(),
    };
  };
  const report = sink.report;
  const update = () => {
    timer = null;
    const next = read();
    if (next || reported) report(next);
    reported = next !== null;
  };
  const removeSource = sink.addSource(read);
  // Settle while a selection is dragged or scrolled rather than chase it.
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(update, 120);
  };
  doc.addEventListener('selectionchange', schedule);
  doc.addEventListener('scroll', schedule, true);
  view.addEventListener('resize', schedule);
  return () => {
    if (timer !== null) clearTimeout(timer);
    removeSource();
    doc.removeEventListener('selectionchange', schedule);
    doc.removeEventListener('scroll', schedule, true);
    view.removeEventListener('resize', schedule);
    if (reported) report(null);
  };
}
