'use client';

import { useSyncExternalStore } from 'react';
import { desktopBridge, type OpenReaderDesktopBridge } from '@/lib/client/desktop-bridge';

const subscribe = () => () => {};

/**
 * The desktop shell's bridge, or null in a browser. The server render and
 * hydration see null, so native actions appear only after hydration.
 */
export function useDesktopBridge(): OpenReaderDesktopBridge | null {
  return useSyncExternalStore(subscribe, desktopBridge, () => null);
}
