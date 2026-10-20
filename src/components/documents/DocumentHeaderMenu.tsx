'use client';

import type { ReactNode } from 'react';
import {
  BookmarkIcon,
  BookmarksListIcon,
  ContentsSearchIcon,
  DotsHorizontalIcon,
  DownloadIcon,
  FileSettingsIcon,
  ListIcon,
  SearchIcon,
  ZoomIcon,
} from '@/components/icons/Icons';
import { UserMenu } from '@/components/auth/UserMenu';
import { ZoomControl, type ZoomSetting } from '@/components/documents/ZoomControl';
import {
  PopoverRoot,
  PopoverSurface,
  PopoverTrigger,
  ToolbarButton,
  Tooltip,
  cn,
  toolbarButtonStyles,
} from '@/components/ui';

export interface SentenceBookmarkControl {
  isBookmarked: boolean;
  /** False while there is no current sentence that can be bookmarked. */
  canToggle: boolean;
  onToggle: () => void;
}

/** The reading controls a ready reader adds to its header. */
export interface ReaderHeaderControls {
  contentsOpen: boolean;
  onToggleContents: () => void;
  sentenceBookmark: SentenceBookmarkControl;
  onViewBookmarks: () => void;
  zoom: ZoomSetting;
}

interface DocumentHeaderMenuProps {
  /** Without it the document actions show disabled, as while the reader prepares. */
  onOpenSettings?: () => void;
  onOpenAudiobook?: () => void;
  isSettingsOpen?: boolean;
  isAudiobookOpen?: boolean;
  showAudiobookExport?: boolean;
  reader?: ReaderHeaderControls;
}

const contentsTooltipIcons = [<ListIcon key="chapters" />, <SearchIcon key="search" />];

const moreTooltipIcons = [<BookmarkIcon key="bookmarks" />, <ZoomIcon key="zoom" />];

function PanelRow({
  onClick,
  disabled,
  active = false,
  className,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active || undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors duration-fast ease-standard focus:outline-none focus-visible:bg-accent-wash focus-visible:text-accent',
        active ? 'bg-accent-wash text-accent' : 'text-foreground hover:bg-accent-wash hover:text-accent',
        'disabled:cursor-not-allowed disabled:bg-transparent disabled:text-faint',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The reader header's actions. Contents and the ⋯ panel are reading
 * controls at every width; export, settings and the account sit beside them
 * on wider screens and move into the ⋯ panel on phones, so each action has
 * one control.
 */
export function DocumentHeaderMenu({
  onOpenSettings,
  onOpenAudiobook,
  isSettingsOpen = false,
  isAudiobookOpen = false,
  showAudiobookExport,
  reader,
}: DocumentHeaderMenuProps) {
  const disabled = !onOpenSettings;
  const showExport = showAudiobookExport && (onOpenAudiobook || disabled);

  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      {/* Reading controls keep their place, disabled, until the reader is ready. */}
      <Tooltip label="Contents" icons={contentsTooltipIcons}>
        <ToolbarButton
          onClick={reader?.onToggleContents}
          disabled={!reader}
          active={reader?.contentsOpen}
          aria-label={reader?.contentsOpen ? 'Hide contents' : 'Open contents'}
        >
          <ContentsSearchIcon aria-hidden="true" className="h-4 w-4" />
        </ToolbarButton>
      </Tooltip>

      <PopoverRoot className="relative">
        {({ open, close }) => (
          <>
            <Tooltip label="More" icons={moreTooltipIcons}>
              <PopoverTrigger
                aria-label="Menu"
                disabled={!reader}
                className={toolbarButtonStyles({ active: open ? 'true' : 'false' })}
              >
                <DotsHorizontalIcon aria-hidden="true" className="h-4 w-4" />
              </PopoverTrigger>
            </Tooltip>
            <PopoverSurface flush anchor={{ to: 'bottom end', gap: 6 }} className="w-56">
              <div className="p-1 sm:hidden">
                {showExport ? (
                  <PanelRow
                    onClick={() => { onOpenAudiobook?.(); close(); }}
                    disabled={disabled}
                    active={isAudiobookOpen}
                  >
                    <DownloadIcon aria-hidden="true" className="h-4 w-4" />
                    {isAudiobookOpen ? 'Hide audiobook export' : 'Export audiobook'}
                  </PanelRow>
                ) : null}
                <PanelRow
                  onClick={() => { onOpenSettings?.(); close(); }}
                  disabled={disabled}
                  active={isSettingsOpen}
                >
                  <FileSettingsIcon aria-hidden="true" className="h-4 w-4" />
                  {isSettingsOpen ? 'Hide settings' : 'Settings'}
                </PanelRow>
              </div>

              {reader ? (
                <>
                  {/* Phones list export and settings above; wider screens start here. */}
                  <div className="border-t border-line-soft p-1 sm:border-t-0">
                    <PanelRow
                      onClick={() => { reader.sentenceBookmark.onToggle(); close(); }}
                      disabled={!reader.sentenceBookmark.canToggle}
                    >
                      <BookmarkIcon aria-hidden="true" filled={reader.sentenceBookmark.isBookmarked} className="h-4 w-4" />
                      {reader.sentenceBookmark.isBookmarked ? 'Remove bookmark' : 'Save bookmark'}
                    </PanelRow>
                    <PanelRow onClick={() => { reader.onViewBookmarks(); close(); }}>
                      <BookmarksListIcon aria-hidden="true" className="h-4 w-4" />
                      View bookmarks
                    </PanelRow>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-line-soft py-1 pl-3 pr-1.5 text-xs text-foreground">
                    <span className="flex items-center gap-2">
                      <ZoomIcon aria-hidden="true" className="h-4 w-4 text-soft" />
                      Zoom
                    </span>
                    <ZoomControl {...reader.zoom} />
                  </div>
                </>
              ) : null}

              {/* Empty on desktop installs, where there is no account menu. */}
              <div className="flex justify-center border-t border-line-soft p-1.5 empty:hidden sm:hidden">
                <UserMenu />
              </div>
            </PopoverSurface>
          </>
        )}
      </PopoverRoot>

      <div className="hidden items-center gap-2 sm:flex">
        <span aria-hidden="true" className="h-4 w-px bg-line" />
        {showExport ? (
          <Tooltip label={isAudiobookOpen ? 'Hide audiobook export' : 'Export audiobook'}>
            <ToolbarButton
              onClick={onOpenAudiobook}
              disabled={disabled}
              active={isAudiobookOpen}
              aria-label={isAudiobookOpen ? 'Hide audiobook export' : 'Open audiobook export'}
            >
              <DownloadIcon aria-hidden="true" className="h-4 w-4" />
            </ToolbarButton>
          </Tooltip>
        ) : null}
        <Tooltip label={isSettingsOpen ? 'Hide document settings' : 'Document settings'}>
          <ToolbarButton
            onClick={onOpenSettings}
            disabled={disabled}
            active={isSettingsOpen}
            aria-label={isSettingsOpen ? 'Hide settings' : 'Open settings'}
          >
            <FileSettingsIcon aria-hidden="true" className="h-4 w-4" />
          </ToolbarButton>
        </Tooltip>
        <UserMenu />
      </div>
    </div>
  );
}
