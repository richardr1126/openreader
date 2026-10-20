'use client';

import { useEffect, useState } from 'react';
import { useDesktopBridge } from '@/hooks/useDesktopBridge';
import type { DesktopUpdateCheckResult, DesktopUpdateState } from '@/lib/client/desktop-bridge';

export interface DesktopUpdates {
  state: DesktopUpdateState;
  /** Whether the shell checks and downloads on its own. */
  automatic: boolean;
  check: () => Promise<DesktopUpdateCheckResult>;
  install: () => Promise<void>;
  setAutomatic: (automatic: boolean) => Promise<void>;
}

/**
 * The desktop shell's updater, or null in a browser and wherever the shell
 * cannot update itself. The state follows the shell as it checks and downloads.
 */
export function useDesktopUpdates(): DesktopUpdates | null {
  const bridge = useDesktopBridge();
  const [info, setInfo] = useState<{ state: DesktopUpdateState; automatic: boolean } | null>(null);

  useEffect(() => {
    if (!bridge?.getUpdates || !bridge.onUpdateState) return;
    let active = true;
    const stop = bridge.onUpdateState((state) => {
      setInfo((current) => (current ? { ...current, state } : current));
    });
    void bridge.getUpdates().then((next) => {
      if (active) setInfo(next);
    });
    return () => {
      active = false;
      stop();
    };
  }, [bridge]);

  if (!bridge?.checkForUpdates || !bridge.installUpdate || !bridge.setAutomaticUpdates || !info) return null;
  const { checkForUpdates, installUpdate, setAutomaticUpdates } = bridge;
  return {
    ...info,
    check: checkForUpdates,
    install: installUpdate,
    setAutomatic: async (automatic) => {
      await setAutomaticUpdates(automatic);
      setInfo((current) => (current ? { ...current, automatic } : current));
    },
  };
}
