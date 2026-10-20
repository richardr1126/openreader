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

/** The shell's updater: idle, checking, downloading (with percent) or ready to install. */
export interface DesktopUpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready';
  version: string | null;
  percent: number | null;
}

export type DesktopUpdateCheckResult =
  | { status: 'latest' }
  | { status: 'available' | 'ready'; version: string }
  | { status: 'error'; message: string };

export interface OpenReaderDesktopBridge {
  onOpenFiles?: (callback: (files: DesktopOpenedFile[]) => void) => () => void;
  setTitleBarColors?: (colors: { background: string; foreground: string }) => void;
  revealDataFolder?: () => Promise<void>;
  openLogsFolder?: () => Promise<void>;
  /** Null where the app cannot update itself (an unpackaged shell). */
  getUpdates?: () => Promise<{ state: DesktopUpdateState; automatic: boolean } | null>;
  onUpdateState?: (callback: (state: DesktopUpdateState) => void) => () => void;
  checkForUpdates?: () => Promise<DesktopUpdateCheckResult>;
  installUpdate?: () => Promise<void>;
  setAutomaticUpdates?: (automatic: boolean) => Promise<void>;
}

declare global {
  interface Window {
    openreaderDesktop?: OpenReaderDesktopBridge;
  }
}

export function desktopBridge(): OpenReaderDesktopBridge | null {
  return typeof window === 'undefined' ? null : window.openreaderDesktop ?? null;
}
