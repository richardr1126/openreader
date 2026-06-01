'use client';

import { Menu, MenuButton, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { DotsVerticalIcon, FileSettingsIcon, DownloadIcon, ListIcon } from '@/components/icons/Icons';
import { ZoomControl } from '@/components/documents/ZoomControl';
import { UserMenu } from '@/components/auth/UserMenu';
import { IconButton, MenuActionItem, MenuItemsSurface, ToolbarButton } from '@/components/ui';

interface DocumentHeaderMenuProps {
  zoomLevel: number;
  onZoomIncrease: () => void;
  onZoomDecrease: () => void;
  onOpenSettings: () => void;
  onOpenAudiobook?: () => void;
  onOpenSegments?: () => void;
  isSettingsOpen?: boolean;
  isAudiobookOpen?: boolean;
  isSegmentsOpen?: boolean;
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
  onOpenSegments,
  isSettingsOpen = false,
  isAudiobookOpen = false,
  isSegmentsOpen = false,
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
      {onOpenSegments && (
        <ToolbarButton
          onClick={onOpenSegments}
          active={isSegmentsOpen}
          aria-label={isSegmentsOpen ? 'Hide segments sidebar' : 'Open segments sidebar'}
          title={isSegmentsOpen ? 'Hide Segments' : 'Segments'}
        >
          <ListIcon className="w-4 h-4 transform transition-transform duration-base ease-standard" />
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
        <FileSettingsIcon className="w-4 h-4 transform transition-transform duration-base ease-standard" />
      </ToolbarButton>
      <UserMenu />
    </div>
  );

  // --- Mobile View ---
  const MobileView = (
    <div className="sm:hidden flex items-center">
      <Menu as="div" className="relative inline-block text-left">
        <MenuButton
          as={IconButton}
          tone="surface"
          size="sm"
          title="Menu"
        >
          <DotsVerticalIcon className="w-4 h-4 transform transition-transform duration-base ease-standard hover:text-accent" />
        </MenuButton>
        <Transition
          as={Fragment}
          enter="transition ease-standard duration-fast"
          enterFrom="transform opacity-0 scale-95"
          enterTo="transform opacity-100 scale-100"
          leave="transition ease-standard duration-fast"
          leaveFrom="transform opacity-100 scale-100"
          leaveTo="transform opacity-0 scale-95"
        >
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
              {onOpenSegments && (
                <MenuActionItem onClick={onOpenSegments} activeOverride={isSegmentsOpen}>
                  <ListIcon className="h-4 w-4" />
                  {isSegmentsOpen ? 'Hide Segments' : 'Segments'}
                </MenuActionItem>
              )}
              {showAudiobookExport && onOpenAudiobook && (
                <MenuActionItem onClick={onOpenAudiobook} activeOverride={isAudiobookOpen}>
                  <DownloadIcon className="h-4 w-4" />
                  {isAudiobookOpen ? 'Hide Audiobook' : 'Export Audiobook'}
                </MenuActionItem>
              )}
              <MenuActionItem onClick={onOpenSettings} activeOverride={isSettingsOpen}>
                <FileSettingsIcon className="h-4 w-4" />
                {isSettingsOpen ? 'Hide Settings' : 'Settings'}
              </MenuActionItem>
            </div>

            {/* Auth Section */}
            <div className="p-2 border-t border-line-soft flex justify-center">
              <UserMenu />
            </div>
          </MenuItemsSurface>
        </Transition>
      </Menu>
    </div>
  );

  return (
    <>
      {DesktopView}
      {MobileView}
    </>
  );
}
