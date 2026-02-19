'use client';

import { Menu, MenuButton, MenuItem, MenuItems, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { DotsVerticalIcon, FileSettingsIcon, DownloadIcon } from '@/components/icons/Icons';
import { ZoomControl } from '@/components/documents/ZoomControl';
import { UserMenu } from '@/components/auth/UserMenu';

interface DocumentHeaderMenuProps {
  zoomLevel: number;
  onZoomIncrease: () => void;
  onZoomDecrease: () => void;
  onOpenSettings: () => void;
  onOpenAudiobook?: () => void;
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
      {showAudiobookExport && onOpenAudiobook && (
        <button
          onClick={onOpenAudiobook}
          className="inline-flex items-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out hover:scale-[1.09] hover:text-accent"
          aria-label="Open audiobook export"
          title="Export Audiobook"
        >
          <DownloadIcon className="w-4 h-4 transform transition-transform duration-200 ease-in-out hover:scale-[1.09] hover:text-accent" />
        </button>
      )}
      <button
        onClick={onOpenSettings}
        className="inline-flex items-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out hover:scale-[1.09] hover:text-accent"
        aria-label="Open settings"
      >
        <FileSettingsIcon className="w-4 h-4 transform transition-transform duration-200 ease-in-out hover:scale-[1.09] hover:text-accent" />
      </button>
      <UserMenu />
    </div>
  );

  // --- Mobile View ---
  const MobileView = (
    <div className="sm:hidden flex items-center">
      <Menu as="div" className="relative inline-block text-left">
        <MenuButton
          className="inline-flex items-center justify-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out hover:scale-[1.09] hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          title="Menu"
        >
          <DotsVerticalIcon className="w-4 h-4 transform transition-transform duration-200 ease-in-out hover:scale-[1.09] hover:text-accent" />
        </MenuButton>
        <Transition
          as={Fragment}
          enter="transition ease-out duration-100"
          enterFrom="transform opacity-0 scale-95"
          enterTo="transform opacity-100 scale-100"
          leave="transition ease-in duration-75"
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
              {showAudiobookExport && onOpenAudiobook && (
                <MenuItem>
                  {({ active }) => (
                    <button
                      onClick={onOpenAudiobook}
                      className={`${active ? 'bg-offbase text-accent' : 'text-foreground'
                        } group flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs`}
                    >
                      <DownloadIcon className="h-4 w-4" />
                      Export Audiobook
                    </button>
                  )}
                </MenuItem>
              )}
              <MenuItem>
                {({ active }) => (
                  <button
                    onClick={onOpenSettings}
                    className={`${active ? 'bg-offbase text-accent' : 'text-foreground'
                      } group flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs`}
                  >
                    <FileSettingsIcon className="h-4 w-4" />
                    Settings
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
