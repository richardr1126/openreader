'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { DownloadIcon, RefreshIcon } from '@/components/icons/Icons';
import { SidebarNavItem } from '@/components/ui';
import { useDesktopUpdates, type DesktopUpdates } from '@/hooks/useDesktopUpdates';

/** What the update control says and does in each updater state. */
function useUpdateControl(updates: DesktopUpdates | null) {
  const [restarting, setRestarting] = useState(false);
  if (!updates) return null;
  const { state } = updates;

  if (state.status === 'ready' || restarting) {
    return {
      label: 'Restart to update',
      shortLabel: 'Restart to update',
      version: state.version,
      disabled: restarting,
      ready: true,
      onClick: () => {
        setRestarting(true);
        void updates.install();
      },
    };
  }
  if (state.status === 'downloading') {
    const progress = state.percent === null ? '' : ` · ${state.percent}%`;
    return {
      label: `Downloading v${state.version}${progress}`,
      shortLabel: `Downloading${state.percent === null ? '' : ` ${state.percent}%`}`,
      version: null,
      disabled: true,
      ready: false,
      onClick: () => {},
    };
  }
  return {
    label: state.status === 'checking' ? 'Checking for updates…' : 'Check for updates',
    shortLabel: state.status === 'checking' ? 'Checking…' : 'Check for updates',
    version: null,
    disabled: state.status === 'checking',
    ready: false,
    onClick: () => {
      void updates.check().then((result) => {
        if (result.status === 'latest') toast.success('OpenReader is up to date.');
        else if (result.status === 'available') toast.success(`Downloading OpenReader ${result.version}.`);
        else if (result.status === 'error') toast.error(`Could not check for updates: ${result.message}`);
      });
    },
  };
}

/** Settings sidebar: check on demand, follow the download, then restart. */
export function DesktopUpdateNavItem() {
  const control = useUpdateControl(useDesktopUpdates());
  if (!control) return null;
  return (
    <SidebarNavItem
      compact
      onClick={control.onClick}
      disabled={control.disabled}
      aria-label={control.label}
      icon={control.ready ? <DownloadIcon className="h-3.5 w-3.5" /> : <RefreshIcon className="h-3.5 w-3.5" />}
      label={control.label}
      className={control.ready ? 'text-accent' : undefined}
    />
  );
}

/** The same control for the narrow settings toolbar, where the sidebar is hidden. */
export function DesktopUpdateToolbarButton({ className }: { className?: string }) {
  const control = useUpdateControl(useDesktopUpdates());
  if (!control) return null;
  return (
    <button
      type="button"
      onClick={control.onClick}
      disabled={control.disabled}
      aria-label={control.label}
      className={`h-7 rounded-md px-2 text-xs font-medium transition-colors hover:bg-accent-wash hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 disabled:hover:bg-transparent ${control.ready ? 'text-accent' : 'text-soft'} ${className ?? ''}`}
    >
      {control.shortLabel}
    </button>
  );
}

/** Library sidebar: appears only once a downloaded update is ready to install. */
export function DesktopRestartToUpdateItem() {
  const control = useUpdateControl(useDesktopUpdates());
  if (!control?.ready) return null;
  return (
    <SidebarNavItem
      compact
      onClick={control.onClick}
      disabled={control.disabled}
      aria-label={control.version ? `Restart to update to v${control.version}` : 'Restart to update'}
      icon={<DownloadIcon className="h-3.5 w-3.5" />}
      label="Restart to update"
      trailing={control.version ? <span className="text-[11px] text-soft">v{control.version}</span> : undefined}
      className="text-accent"
    />
  );
}
