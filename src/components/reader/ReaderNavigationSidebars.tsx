'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTTS } from '@/contexts/TTSContext';
import { useDocumentBookmarks } from '@/hooks/useDocumentBookmarks';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { IconButton, Input, SearchField } from '@/components/ui';
import { PencilIcon, SearchIcon } from '@/components/icons/Icons';
import { TrashIcon } from '@/components/doclist/window/finderIcons';
import { formatBookmarkAge } from '@/lib/client/reader/bookmarks';
import { resolveReadingPositionOrdinal } from '@/lib/shared/reading-position';
import type { DocumentBookmark } from '@/types/bookmarks';
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

export type ReaderNavigationPanel = 'contents' | 'search' | 'bookmarks';

export function isReaderNavigationPanel(value: string | null): value is ReaderNavigationPanel {
  return value === 'contents' || value === 'search' || value === 'bookmarks';
}

/**
 * Contents, find-in-book and bookmarks for every reader. Each resolves to a
 * worker-plan ordinal and seeks through the same command as tapping a
 * sentence, so none creates a playback session or moves the view
 * independently of the playback cursor.
 */
export function ReaderNavigationSidebars({
  open,
  onClose,
  outline,
  documentTitle,
  documentId,
}: {
  open: ReaderNavigationPanel | null;
  onClose: () => void;
  outline: readonly OutlineEntry[];
  documentTitle: string;
  documentId: string;
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
      <ReaderSidebarShell
        isOpen={open === 'bookmarks'}
        onClose={onClose}
        ariaLabel="Bookmarks"
        title="Bookmarks"
        panelClassName="w-full sm:w-[24rem]"
        bodyClassName="flex-1 overflow-y-auto px-2 py-2"
      >
        <BookmarksPanel documentId={documentId} />
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

function BookmarksPanel({ documentId }: { documentId: string }) {
  const { playbackSegments, skipToOrdinal } = useTTS();
  const { bookmarks, isLoading, isError, rename, remove } = useDocumentBookmarks(documentId);
  // Ages are relative to when the panel opened; it remounts on every open.
  const [now] = useState(() => Date.now());

  const seek = (bookmark: DocumentBookmark) => {
    const ordinal = resolveReadingPositionOrdinal(playbackSegments, bookmark);
    if (ordinal === null || !skipToOrdinal(ordinal)) {
      toast.error('This bookmark is not in the prepared document yet.');
    }
  };

  if (isLoading) return <p className="px-2 py-4 text-xs text-soft">Loading bookmarks…</p>;
  if (isError && bookmarks.length === 0) {
    return <p className="px-2 py-4 text-xs text-soft">Bookmarks could not be loaded.</p>;
  }
  if (bookmarks.length === 0) {
    return (
      <p className="px-2 py-4 text-xs leading-relaxed text-soft">
        No bookmarks yet. Use the bookmark button in the toolbar to save the sentence being read.
      </p>
    );
  }
  return (
    <ol className="space-y-0.5" aria-label="Bookmarks">
      {bookmarks.map((bookmark) => (
        <BookmarkRow
          key={bookmark.id}
          bookmark={bookmark}
          age={formatBookmarkAge(bookmark.createdAtMs, now)}
          onSeek={() => seek(bookmark)}
          onRename={(label) => rename({ id: bookmark.id, label })}
          onDelete={() => remove(bookmark.id)}
        />
      ))}
    </ol>
  );
}

function BookmarkRow({
  bookmark,
  age,
  onSeek,
  onRename,
  onDelete,
}: {
  bookmark: DocumentBookmark;
  age: string;
  onSeek: () => void;
  onRename: (label: string | null) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const name = bookmark.label || bookmark.snippet || 'Bookmark';

  const commit = () => {
    if (draft === null) return;
    const label = draft.trim() || null;
    setDraft(null);
    if (label !== bookmark.label) onRename(label);
  };

  return (
    <li className="group flex items-start gap-1 rounded-md hover:bg-surface-sunken">
      {draft !== null ? (
        <div className="flex-1 px-2 py-1.5">
          <Input
            autoFocus
            controlSize="sm"
            aria-label="Bookmark name"
            placeholder={bookmark.snippet}
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') {
                event.stopPropagation();
                setDraft(null);
              }
            }}
            className="w-full"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onSeek}
          aria-label={name}
          className="min-w-0 flex-1 px-2 py-1.5 text-left transition-colors duration-fast"
        >
          {bookmark.label ? (
            <span className="block truncate text-sm font-medium text-foreground">{bookmark.label}</span>
          ) : null}
          <span className={`line-clamp-2 text-xs leading-relaxed ${bookmark.label ? 'text-soft' : 'text-foreground'}`}>
            {bookmark.snippet}
          </span>
          <span className="mt-0.5 block text-[11px] text-faint">{age}</span>
        </button>
      )}
      {draft === null ? (
        <div className="flex shrink-0 items-center gap-0.5 py-1.5 pr-1">
          <IconButton
            tone="ghost"
            size="sm"
            aria-label={`Rename bookmark ${name}`}
            title="Rename"
            onClick={() => setDraft(bookmark.label ?? '')}
          >
            <PencilIcon aria-hidden="true" className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            tone="danger"
            size="sm"
            aria-label={`Delete bookmark ${name}`}
            title="Delete"
            onClick={onDelete}
          >
            <TrashIcon aria-hidden="true" className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ) : null}
    </li>
  );
}
