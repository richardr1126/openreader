'use client';

import { DotsVerticalIcon, FileSettingsIcon, DownloadIcon } from '@/components/icons/Icons';
import { UserMenu } from '@/components/auth/UserMenu';
import { IconButton, MenuActionItem, MenuItemsSurface, MenuRoot, MenuTransition, MenuTrigger, ToolbarButton, Tooltip } from '@/components/ui';

interface DocumentHeaderMenuProps {
  /** Without it the document actions show disabled, as while the reader prepares. */
  onOpenSettings?: () => void;
  onOpenAudiobook?: () => void;
  isSettingsOpen?: boolean;
  isAudiobookOpen?: boolean;
  showAudiobookExport?: boolean;
}

export function DocumentHeaderMenu({
  onOpenSettings,
  onOpenAudiobook,
  isSettingsOpen = false,
  isAudiobookOpen = false,
  showAudiobookExport,
}: DocumentHeaderMenuProps) {
  const disabled = !onOpenSettings;

  // --- Desktop View ---
  const DesktopView = (
    <div className="hidden sm:flex items-center gap-2">
      {showAudiobookExport && (onOpenAudiobook || disabled) && (
        <Tooltip label={isAudiobookOpen ? 'Hide audiobook export' : 'Export audiobook'}>
          <ToolbarButton
            onClick={onOpenAudiobook}
            disabled={disabled}
            active={isAudiobookOpen}
            aria-label={isAudiobookOpen ? 'Hide audiobook export' : 'Open audiobook export'}
          >
            <DownloadIcon className="w-4 h-4 transform transition-transform duration-base ease-standard" />
          </ToolbarButton>
        </Tooltip>
      )}
      <Tooltip label={isSettingsOpen ? 'Hide document settings' : 'Document settings'}>
        <ToolbarButton
          onClick={onOpenSettings}
          disabled={disabled}
          active={isSettingsOpen}
          aria-label={isSettingsOpen ? 'Hide settings' : 'Open settings'}
        >
          <FileSettingsIcon
            aria-hidden="true"
            className="w-4 h-4 transform transition-transform duration-base ease-standard"
          />
        </ToolbarButton>
      </Tooltip>
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
          aria-label="Menu"
        >
          <DotsVerticalIcon className="w-4 h-4 transform transition-transform duration-base ease-standard hover:text-accent" />
        </MenuTrigger>
        <MenuTransition>
          <MenuItemsSurface className="absolute right-0 z-50 mt-2 min-w-max origin-top-right divide-y divide-line-soft focus:outline-none">
            {/* Actions Section */}
            <div className="p-1">
              {showAudiobookExport && (onOpenAudiobook || disabled) && (
                <MenuActionItem onClick={onOpenAudiobook} disabled={disabled} activeOverride={isAudiobookOpen}>
                  <DownloadIcon className="h-4 w-4" />
                  {isAudiobookOpen ? 'Hide Audiobook' : 'Export Audiobook'}
                </MenuActionItem>
              )}
              <MenuActionItem onClick={onOpenSettings} disabled={disabled} activeOverride={isSettingsOpen}>
                <FileSettingsIcon aria-hidden="true" className="h-4 w-4" />
                {isSettingsOpen ? 'Hide Settings' : 'Settings'}
              </MenuActionItem>
            </div>

            {/* Auth Section (empty on desktop, where there is no account menu) */}
            <div className="p-2 border-t border-line-soft flex justify-center empty:hidden">
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
