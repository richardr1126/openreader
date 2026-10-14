/**
 * The desktop shell's preload bridge (`desktop/src/preload.cjs`). It is a
 * capability, not a mode: the UI offers a native action only when the bridge has
 * it, and never reads `installProfile` to decide (v5/DESKTOP_SINGLE_OWNER.md).
 */
export interface DesktopOpenedFile {
  name: string;
  lastModified: number;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface OpenReaderDesktopBridge {
  onOpenFiles?: (callback: (files: DesktopOpenedFile[]) => void) => () => void;
  revealDataFolder?: () => Promise<void>;
  openLogsFolder?: () => Promise<void>;
}

declare global {
  interface Window {
    openreaderDesktop?: OpenReaderDesktopBridge;
  }
}

export function desktopBridge(): OpenReaderDesktopBridge | null {
  return typeof window === 'undefined' ? null : window.openreaderDesktop ?? null;
}
