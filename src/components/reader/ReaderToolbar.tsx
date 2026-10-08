'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useTTS } from '@/contexts/TTSContext';
import {
  BookmarkIcon,
  BookmarksListIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
  SearchIcon,
} from '@/components/icons/Icons';
import {
  Input, MenuActionItem, MenuItemsSurface, MenuRoot, MenuTransition, MenuTrigger,
  PopoverRoot, PopoverSurface, PopoverTrigger, ToolbarButton, cn,
} from '@/components/ui';
import type { ReaderNavigationPanel } from '@/components/reader/ReaderNavigationSidebars';

export interface SentenceBookmarkControl {
  isBookmarked: boolean;
  /** False while there is no current sentence that can be bookmarked. */
  canToggle: boolean;
  onToggle: () => void;
}

const compactButton = 'px-1.5 sm:px-2';

/**
 * The reading toolbar under the document header, shared by every reader:
 * contents and find on the left, the reader's position cluster in the centre
 * (`navigation` slot), and a menu for saving and viewing bookmarks on the
 * right. Document-level actions (zoom, export, settings) stay in the header.
 */
export function ReaderToolbar({
  activePanel,
  onTogglePanel,
  sentenceBookmark,
  navigation,
  hidden = false,
}: {
  activePanel: ReaderNavigationPanel | null;
  onTogglePanel: (panel: ReaderNavigationPanel) => void;
  sentenceBookmark: SentenceBookmarkControl;
  navigation?: ReactNode;
  /** Keeps the toolbar's height while the reader is still loading. */
  hidden?: boolean;
}) {
  const contentsOpen = activePanel === 'contents';
  const searchOpen = activePanel === 'search';
  const bookmarksOpen = activePanel === 'bookmarks';
  return (
    <div
      role="toolbar"
      aria-label="Reader"
      data-reader-toolbar
      aria-hidden={hidden || undefined}
      className={cn(
        'flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line-soft bg-surface px-4 text-xs text-soft',
        hidden && 'invisible',
      )}
    >
      <div className="flex items-center gap-1">
        <ToolbarButton
          onClick={() => onTogglePanel('contents')}
          active={contentsOpen}
          aria-label={contentsOpen ? 'Hide contents' : 'Open contents'}
          title="Contents"
          className={compactButton}
        >
          <ListIcon aria-hidden="true" className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => onTogglePanel('search')}
          active={searchOpen}
          aria-label={searchOpen ? 'Hide find in book' : 'Find in book'}
          title="Find in Book"
          className={compactButton}
        >
          <SearchIcon aria-hidden="true" className="h-4 w-4" />
        </ToolbarButton>
      </div>
      <div className="flex min-w-0 items-center justify-center">{navigation}</div>
      <MenuRoot as="div" className="relative inline-flex shrink-0 items-center text-left">
        <MenuTrigger
          as={ToolbarButton}
          active={bookmarksOpen || sentenceBookmark.isBookmarked}
          aria-label="Bookmarks"
          title="Bookmarks"
          className={compactButton}
        >
          <BookmarkIcon aria-hidden="true" filled={sentenceBookmark.isBookmarked} className="h-4 w-4" />
        </MenuTrigger>
        <MenuTransition>
          <MenuItemsSurface anchor="bottom end" className="z-50 mt-1 min-w-[180px] focus:outline-none">
            <MenuActionItem
              onClick={sentenceBookmark.onToggle}
              disabled={!sentenceBookmark.canToggle}
            >
              <BookmarkIcon aria-hidden="true" filled={sentenceBookmark.isBookmarked} className="h-4 w-4" />
              {sentenceBookmark.isBookmarked ? 'Remove bookmark' : 'Save bookmark'}
            </MenuActionItem>
            <MenuActionItem onClick={() => {
              if (!bookmarksOpen) onTogglePanel('bookmarks');
            }}>
              <BookmarksListIcon aria-hidden="true" className="h-4 w-4" />
              View bookmarks
            </MenuActionItem>
          </MenuItemsSurface>
        </MenuTransition>
      </MenuRoot>
    </div>
  );
}

/** Previous · position · next, grouped as one cluster. */
export function ReaderPager({
  unit,
  onPrevious,
  onNext,
  canPrevious = true,
  canNext = true,
  position,
}: {
  /** Names the step, e.g. "page" or "section" ("Previous page"). */
  unit: string;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious?: boolean;
  canNext?: boolean;
  position: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <ToolbarButton
        onClick={onPrevious}
        disabled={!canPrevious}
        aria-label={`Previous ${unit}`}
        className={cn(compactButton, 'disabled:cursor-not-allowed disabled:opacity-50')}
      >
        <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
      </ToolbarButton>
      {position}
      <ToolbarButton
        onClick={onNext}
        disabled={!canNext}
        aria-label={`Next ${unit}`}
        className={cn(compactButton, 'disabled:cursor-not-allowed disabled:opacity-50')}
      >
        <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
      </ToolbarButton>
    </div>
  );
}

/** A plain `current / total` readout. */
export function ReaderPosition({ current, total }: { current: number; total: number }) {
  return (
    <span className="whitespace-nowrap px-1.5 tabular-nums">
      {current} / {total}
    </span>
  );
}

/** The page readout that opens a "go to page" field. */
export function PageJumpControl({
  currentPage,
  numPages,
  onGoToPage,
}: {
  currentPage: number;
  numPages: number;
  onGoToPage: (page: number) => void;
}) {
  const [inputValue, setInputValue] = useState('');
  const [popoverKey, setPopoverKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const confirm = (close?: () => void) => {
    const parsed = Number.parseInt(inputValue, 10);
    if (Number.isNaN(parsed)) return;
    const page = Math.min(Math.max(parsed, 1), Math.max(1, numPages));
    close?.();
    if (page !== currentPage) onGoToPage(page);
    setInputValue('');
    if (close) {
      setPopoverKey((key) => key + 1);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  return (
    <PopoverRoot key={popoverKey} className="relative">
      {({ close }) => (
        <>
          <PopoverTrigger
            ref={triggerRef}
            className="whitespace-nowrap rounded-md bg-surface-sunken px-2 py-1 text-xs tabular-nums"
            onClick={() => {
              setInputValue('');
              window.setTimeout(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
              }, 50);
            }}
          >
            {currentPage} / {numPages}
          </PopoverTrigger>
          <PopoverSurface anchor="bottom">
            <div className="flex flex-col space-y-2">
              <div className="text-xs font-medium text-foreground">Go to page</div>
              <Input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                controlSize="sm"
                className="w-20 appearance-none border-none text-center text-accent"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value.replace(/[^0-9]/g, ''))}
                onBlur={() => confirm()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') confirm(close);
                }}
                placeholder={currentPage.toString()}
                aria-label="Page number"
              />
              <div className="text-center text-xs text-soft">of {numPages}</div>
            </div>
          </PopoverSurface>
        </>
      )}
    </PopoverRoot>
  );
}

/** How far through the playback plan the current sentence is. */
export function ReadingProgress() {
  const { currentSentenceOrdinal, playbackPlanSegmentCount } = useTTS();
  if (!playbackPlanSegmentCount || currentSentenceOrdinal === null) return null;
  const percent = Math.round(((currentSentenceOrdinal + 1) / playbackPlanSegmentCount) * 100);
  return (
    <span className="whitespace-nowrap tabular-nums" aria-label={`Reading position ${percent}%`}>
      {percent}%
    </span>
  );
}
