'use client';

import { BookmarkIcon, BookmarksListIcon, DotsVerticalIcon, FileSettingsIcon, DownloadIcon, ListIcon, SearchIcon } from '@/components/icons/Icons';
import { ZoomControl } from '@/components/documents/ZoomControl';
import { UserMenu } from '@/components/auth/UserMenu';
import { IconButton, MenuActionItem, MenuItemsSurface, MenuRoot, MenuTransition, MenuTrigger, ToolbarButton } from '@/components/ui';

export interface SentenceBookmarkControl {
  isBookmarked: boolean;
  /** False while there is no current sentence that can be bookmarked. */
  canToggle: boolean;
  onToggle: () => void;
}

interface DocumentHeaderMenuProps {
  zoomLevel: number;
  onZoomIncrease: () => void;
  onZoomDecrease: () => void;
  onOpenSettings: () => void;
  onOpenAudiobook?: () => void;
  onOpenContents?: () => void;
  onOpenSearch?: () => void;
  onOpenBookmarks?: () => void;
  /** Toggles a bookmark on the current playback sentence. */
  sentenceBookmark?: SentenceBookmarkControl;
  isSettingsOpen?: boolean;
  isContentsOpen?: boolean;
  isSearchOpen?: boolean;
  isBookmarksOpen?: boolean;
  isAudiobookOpen?: boolean;
  showAudiobookExport?: boolean;
  minZoom?: number;
  maxZoom?: number;
}

export function DocumentHeaderMenu({
  zoomLevel,
  onZoomIncrease,
  onZoomDecrease,
  onOpenSettings,
  onOpenAudiobook,
  onOpenContents,
  onOpenSearch,
  onOpenBookmarks,
  sentenceBookmark,
  isSettingsOpen = false,
  isContentsOpen = false,
  isSearchOpen = false,
  isBookmarksOpen = false,
  isAudiobookOpen = false,
  showAudiobookExport,
  minZoom = 0,
  maxZoom = 100
}: DocumentHeaderMenuProps) {

  // --- Desktop View ---
  const DesktopView = (
    <div className="hidden sm:flex items-center gap-2">
      <ZoomControl
        value={zoomLevel}
        onIncrease={onZoomIncrease}
        onDecrease={onZoomDecrease}
        min={minZoom}
        max={maxZoom}
      />
      {/* Reading navigation. */}
      {onOpenContents && (
        <ToolbarButton
          onClick={onOpenContents}
          active={isContentsOpen}
          aria-label={isContentsOpen ? 'Hide contents' : 'Open contents'}
          title={isContentsOpen ? 'Hide Contents' : 'Contents'}
        >
          <ListIcon aria-hidden="true" className="w-4 h-4" />
        </ToolbarButton>
      )}
      {onOpenSearch && (
        <ToolbarButton
          onClick={onOpenSearch}
          active={isSearchOpen}
          aria-label={isSearchOpen ? 'Hide find in book' : 'Find in book'}
          title={isSearchOpen ? 'Hide Find' : 'Find in Book'}
        >
          <SearchIcon aria-hidden="true" className="w-4 h-4" />
        </ToolbarButton>
      )}
      {sentenceBookmark && (
        <ToolbarButton
          onClick={sentenceBookmark.onToggle}
          disabled={!sentenceBookmark.canToggle}
          active={sentenceBookmark.isBookmarked}
          aria-pressed={sentenceBookmark.isBookmarked}
          aria-label="Bookmark current sentence"
          className="disabled:cursor-not-allowed disabled:opacity-50"
          title={sentenceBookmark.isBookmarked ? 'Remove Bookmark' : 'Bookmark Current Sentence'}
        >
          <BookmarkIcon aria-hidden="true" filled={sentenceBookmark.isBookmarked} className="w-4 h-4" />
        </ToolbarButton>
      )}
      {onOpenBookmarks && (
        <ToolbarButton
          onClick={onOpenBookmarks}
          active={isBookmarksOpen}
          aria-label={isBookmarksOpen ? 'Hide bookmarks' : 'Open bookmarks'}
          title={isBookmarksOpen ? 'Hide Bookmarks' : 'Bookmarks'}
        >
          <BookmarksListIcon aria-hidden="true" className="w-4 h-4" />
        </ToolbarButton>
      )}
      {showAudiobookExport && onOpenAudiobook && (
        <ToolbarButton
          onClick={onOpenAudiobook}
          active={isAudiobookOpen}
          aria-label={isAudiobookOpen ? 'Hide audiobook export' : 'Open audiobook export'}
          title={isAudiobookOpen ? 'Hide Export Audiobook' : 'Export Audiobook'}
        >
          <DownloadIcon className="w-4 h-4 transform transition-transform duration-base ease-standard" />
        </ToolbarButton>
      )}
      <ToolbarButton
        onClick={onOpenSettings}
        active={isSettingsOpen}
        aria-label={isSettingsOpen ? 'Hide settings' : 'Open settings'}
        title={isSettingsOpen ? 'Hide Settings' : 'Settings'}
      >
        <FileSettingsIcon
          aria-hidden="true"
          className="w-4 h-4 transform transition-transform duration-base ease-standard"
        />
      </ToolbarButton>
      <UserMenu />
    </div>
  );

  // --- Mobile View ---
  const MobileView = (
    <div className="sm:hidden flex items-center">
      <MenuRoot as="div" className="relative inline-block text-left">
        <MenuTrigger
          as={IconButton}
          tone="surface"
          size="sm"
          title="Menu"
        >
          <DotsVerticalIcon className="w-4 h-4 transform transition-transform duration-base ease-standard hover:text-accent" />
        </MenuTrigger>
        <MenuTransition>
          <MenuItemsSurface className="absolute right-0 z-50 mt-2 min-w-max origin-top-right divide-y divide-line-soft focus:outline-none">
            {/* Zoom Controls Section */}
            <div className="px-4 py-3">
              <p className="text-xs font-medium text-soft mb-2">Zoom / Padding</p>
              <div className="flex justify-center">
                <ZoomControl
                  value={zoomLevel}
                  onIncrease={onZoomIncrease}
                  onDecrease={onZoomDecrease}
                  min={minZoom}
                  max={maxZoom}
                />
              </div>
            </div>

            {/* Actions Section */}
            <div className="p-1">
              {onOpenContents && (
                <MenuActionItem onClick={onOpenContents} activeOverride={isContentsOpen}>
                  <ListIcon aria-hidden="true" className="h-4 w-4" />
                  {isContentsOpen ? 'Hide Contents' : 'Contents'}
                </MenuActionItem>
              )}
              {onOpenSearch && (
                <MenuActionItem onClick={onOpenSearch} activeOverride={isSearchOpen}>
                  <SearchIcon aria-hidden="true" className="h-4 w-4" />
                  {isSearchOpen ? 'Hide Find' : 'Find in Book'}
                </MenuActionItem>
              )}
              {sentenceBookmark && (
                <MenuActionItem
                  onClick={sentenceBookmark.onToggle}
                  disabled={!sentenceBookmark.canToggle}
                  activeOverride={sentenceBookmark.isBookmarked}
                >
                  <BookmarkIcon aria-hidden="true" filled={sentenceBookmark.isBookmarked} className="h-4 w-4" />
                  {sentenceBookmark.isBookmarked ? 'Remove Bookmark' : 'Bookmark Sentence'}
                </MenuActionItem>
              )}
              {onOpenBookmarks && (
                <MenuActionItem onClick={onOpenBookmarks} activeOverride={isBookmarksOpen}>
                  <BookmarksListIcon aria-hidden="true" className="h-4 w-4" />
                  {isBookmarksOpen ? 'Hide Bookmarks' : 'Bookmarks'}
                </MenuActionItem>
              )}
              {showAudiobookExport && onOpenAudiobook && (
                <MenuActionItem onClick={onOpenAudiobook} activeOverride={isAudiobookOpen}>
                  <DownloadIcon className="h-4 w-4" />
                  {isAudiobookOpen ? 'Hide Audiobook' : 'Export Audiobook'}
                </MenuActionItem>
              )}
              <MenuActionItem onClick={onOpenSettings} activeOverride={isSettingsOpen}>
                <FileSettingsIcon aria-hidden="true" className="h-4 w-4" />
                {isSettingsOpen ? 'Hide Settings' : 'Settings'}
              </MenuActionItem>
            </div>

            {/* Auth Section */}
            <div className="p-2 border-t border-line-soft flex justify-center">
              <UserMenu />
            </div>
          </MenuItemsSurface>
        </MenuTransition>
      </MenuRoot>
    </div>
  );

  return (
    <>
      {DesktopView}
      {MobileView}
    </>
  );
}
