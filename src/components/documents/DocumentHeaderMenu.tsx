'use client';

import { Menu, MenuButton, MenuItem, MenuItems, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { DotsVerticalIcon, FileSettingsIcon, DownloadIcon, ListIcon } from '@/components/icons/Icons';
import { ZoomControl } from '@/components/documents/ZoomControl';
import { UserMenu } from '@/components/auth/UserMenu';

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
        <button
          onClick={onOpenSegments}
          className={`inline-flex items-center py-1 px-2 rounded-md border bg-base text-xs transition duration-base ease-standard ${
            isSegmentsOpen
              ? 'border-accent text-accent bg-offbase'
              : 'border-offbase text-foreground hover:bg-offbase hover:text-accent'
          }`}
          aria-label={isSegmentsOpen ? 'Hide segments sidebar' : 'Open segments sidebar'}
          title={isSegmentsOpen ? 'Hide Segments' : 'Segments'}
        >
          <ListIcon className="w-4 h-4 transform transition-transform duration-base ease-standard" />
        </button>
      )}
      {showAudiobookExport && onOpenAudiobook && (
        <button
          onClick={onOpenAudiobook}
          className={`inline-flex items-center py-1 px-2 rounded-md border bg-base text-xs transition duration-base ease-standard ${
            isAudiobookOpen
              ? 'border-accent text-accent bg-offbase'
              : 'border-offbase text-foreground hover:bg-offbase hover:text-accent'
          }`}
          aria-label={isAudiobookOpen ? 'Hide audiobook export' : 'Open audiobook export'}
          title={isAudiobookOpen ? 'Hide Export Audiobook' : 'Export Audiobook'}
        >
          <DownloadIcon className="w-4 h-4 transform transition-transform duration-base ease-standard" />
        </button>
      )}
      <button
        onClick={onOpenSettings}
        className={`inline-flex items-center py-1 px-2 rounded-md border bg-base text-xs transition duration-base ease-standard ${
          isSettingsOpen
            ? 'border-accent text-accent bg-offbase'
            : 'border-offbase text-foreground hover:bg-offbase hover:text-accent'
        }`}
        aria-label={isSettingsOpen ? 'Hide settings' : 'Open settings'}
        title={isSettingsOpen ? 'Hide Settings' : 'Settings'}
      >
        <FileSettingsIcon className="w-4 h-4 transform transition-transform duration-base ease-standard" />
      </button>
      <UserMenu />
    </div>
  );

  // --- Mobile View ---
  const MobileView = (
    <div className="sm:hidden flex items-center">
      <Menu as="div" className="relative inline-block text-left">
        <MenuButton
          className="inline-flex items-center justify-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition duration-base ease-standard hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
          <MenuItems className="absolute right-0 mt-2 min-w-max origin-top-right divide-y divide-offbase rounded-md bg-base shadow-lg ring-1 ring-black/5 focus:outline-none z-50">
            {/* Zoom Controls Section */}
            <div className="px-4 py-3">
              <p className="text-xs font-medium text-muted mb-2">Zoom / Padding</p>
              <div className="flex justify-center">
                <ZoomControl
                  value={zoomLevel}
                  onIncrease={() => {
                    // We wrap in a handler to stop propagation if needed, 
                    // but ZoomControl buttons handle their own clicks.
                    // However, Menu might close on click?
                    // Headless UI Menu closes on click inside MenuItem, but these are just buttons in a div.
                    // It should NOT close unless we click a MenuItem.
                    onZoomIncrease();
                  }}
                  onDecrease={onZoomDecrease}
                  min={minZoom}
                  max={maxZoom}
                />
              </div>
            </div>

            {/* Actions Section */}
            <div className="p-1">
              {onOpenSegments && (
                <MenuItem>
                  {({ active }) => (
                    <button
                      onClick={onOpenSegments}
                      className={`${active || isSegmentsOpen ? 'bg-offbase text-accent' : 'text-foreground'
                        } group flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs`}
                    >
                      <ListIcon className="h-4 w-4" />
                      {isSegmentsOpen ? 'Hide Segments' : 'Segments'}
                    </button>
                  )}
                </MenuItem>
              )}
              {showAudiobookExport && onOpenAudiobook && (
                <MenuItem>
                  {({ active }) => (
                    <button
                      onClick={onOpenAudiobook}
                      className={`${active || isAudiobookOpen ? 'bg-offbase text-accent' : 'text-foreground'
                        } group flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs`}
                    >
                      <DownloadIcon className="h-4 w-4" />
                      {isAudiobookOpen ? 'Hide Audiobook' : 'Export Audiobook'}
                    </button>
                  )}
                </MenuItem>
              )}
              <MenuItem>
                {({ active }) => (
                  <button
                    onClick={onOpenSettings}
                    className={`${active || isSettingsOpen ? 'bg-offbase text-accent' : 'text-foreground'
                      } group flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs`}
                  >
                    <FileSettingsIcon className="h-4 w-4" />
                    {isSettingsOpen ? 'Hide Settings' : 'Settings'}
                  </button>
                )}
              </MenuItem>
            </div>

            {/* Auth Section */}
            <div className="p-2 border-t border-offbase flex justify-center">
              <UserMenu />
            </div>
          </MenuItems>
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
