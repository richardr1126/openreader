'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTTS } from '@/contexts/TTSContext';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { SearchField } from '@/components/ui';
import { SearchIcon } from '@/components/icons/Icons';
import {
  BOOK_SEARCH_RESULT_LIMIT,
  buildBookSearchIndex,
  searchBookIndex,
} from '@/lib/client/reader/book-search';
import {
  chapterIndexForOrdinal,
  deriveChapters,
  type OutlineEntry,
} from '@/lib/client/reader/chapters';

export type ReaderNavigationPanel = 'contents' | 'search';

/**
 * Contents and find-in-book for every reader. Both resolve to worker-plan
 * ordinals and seek through the same command as tapping a sentence, so they
 * never create a playback session or move the view independently of the
 * playback cursor.
 */
export function ReaderNavigationSidebars({
  open,
  onClose,
  outline,
  documentTitle,
}: {
  open: ReaderNavigationPanel | null;
  onClose: () => void;
  outline: readonly OutlineEntry[];
  documentTitle: string;
}) {
  return (
    <>
      <ReaderSidebarShell
        isOpen={open === 'contents'}
        onClose={onClose}
        ariaLabel="Contents"
        title="Contents"
        panelClassName="w-full sm:w-[24rem]"
        bodyClassName="flex-1 overflow-y-auto px-2 py-2"
      >
        <ContentsList outline={outline} documentTitle={documentTitle} onChoose={onClose} />
      </ReaderSidebarShell>
      <ReaderSidebarShell
        isOpen={open === 'search'}
        onClose={onClose}
        ariaLabel="Find in book"
        title="Find in book"
        panelClassName="w-full sm:w-[24rem]"
        bodyClassName="flex-1 min-h-0 flex flex-col"
      >
        <SearchPanel />
      </ReaderSidebarShell>
    </>
  );
}

function ContentsList({
  outline,
  documentTitle,
  onChoose,
}: {
  outline: readonly OutlineEntry[];
  documentTitle: string;
  onChoose: () => void;
}) {
  const { playbackSegments, currentSentenceOrdinal, skipToOrdinal } = useTTS();
  const chapters = useMemo(
    () => deriveChapters(playbackSegments, outline, documentTitle),
    [documentTitle, outline, playbackSegments],
  );
  const currentIndex = chapterIndexForOrdinal(chapters, currentSentenceOrdinal);
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  if (chapters.length === 0) {
    return <p className="px-2 py-4 text-xs text-soft">Contents appear once the document is prepared.</p>;
  }
  return (
    <ol className="space-y-0.5" aria-label="Chapters">
      {chapters.map((chapter, index) => {
        const isCurrent = index === currentIndex;
        return (
          <li key={`${chapter.startOrdinal}-${index}`}>
            <button
              ref={isCurrent ? currentRef : undefined}
              type="button"
              aria-current={isCurrent ? 'true' : undefined}
              onClick={() => {
                skipToOrdinal(chapter.startOrdinal);
                onChoose();
              }}
              style={{ paddingLeft: `${0.5 + chapter.depth * 0.875}rem` }}
              className={`w-full rounded-md py-1.5 pr-2 text-left text-sm transition-colors duration-fast ${
                isCurrent ? 'bg-accent-wash text-accent font-medium' : 'text-foreground hover:bg-surface-sunken'
              }`}
            >
              <span className="line-clamp-2">{chapter.title}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function SearchPanel() {
  const { playbackSegments, skipToOrdinal } = useTTS();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  // Built once per open panel and plan; the panel unmounts when closed.
  const index = useMemo(() => buildBookSearchIndex(playbackSegments), [playbackSegments]);
  const results = useMemo(
    () => searchBookIndex(index, deferredQuery, BOOK_SEARCH_RESULT_LIMIT),
    [deferredQuery, index],
  );
  const trimmed = deferredQuery.trim();

  return (
    <>
      <div className="border-b border-line-soft px-4 py-3">
        <SearchField
          autoFocus
          aria-label="Find in book"
          placeholder="Find in book"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          icon={<SearchIcon className="h-3.5 w-3.5" />}
        />
        {trimmed ? (
          <p className="mt-1.5 text-xs text-soft" aria-live="polite">
            {results.length === 0
              ? 'No matches'
              : results.length >= BOOK_SEARCH_RESULT_LIMIT
                ? `First ${BOOK_SEARCH_RESULT_LIMIT} matches`
                : `${results.length} ${results.length === 1 ? 'match' : 'matches'}`}
          </p>
        ) : null}
      </div>
      <ol className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5" aria-label="Search results">
        {results.map((result) => (
          <li key={result.id}>
            <button
              type="button"
              onClick={() => skipToOrdinal(result.ordinal)}
              className="w-full rounded-md px-2 py-1.5 text-left text-xs leading-relaxed text-soft transition-colors duration-fast hover:bg-surface-sunken"
            >
              {result.snippet.slice(0, result.matchStart)}
              <mark className="rounded-sm bg-accent-wash px-0.5 text-accent">
                {result.snippet.slice(result.matchStart, result.matchEnd)}
              </mark>
              {result.snippet.slice(result.matchEnd)}
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}
