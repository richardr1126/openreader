'use client';

import type { ReactNode } from 'react';
import { LibraryFrame, useIsNarrow } from '@/components/layout';

interface FinderWindowProps {
  toolbar: ReactNode;
  banner?: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  /** Controlled sidebar open/closed state (drives mobile drawer + desktop collapse). */
  sidebarOpen: boolean;
  /** Handles close requests from mobile drawer interactions (backdrop tap, Esc). */
  onRequestSidebarClose?: () => void;
}

export { useIsNarrow };

/**
 * Finder-style file pane: sidebar + toolbar + content + status bar.
 * No separate window chrome — it sits flush under the existing app header.
 */
export function FinderWindow({
  toolbar,
  banner,
  sidebar,
  children,
  sidebarOpen,
  onRequestSidebarClose,
}: FinderWindowProps) {
  return (
    <LibraryFrame
      toolbar={toolbar}
      banner={banner}
      sidebar={sidebar}
      sidebarOpen={sidebarOpen}
      onRequestSidebarClose={onRequestSidebarClose}
    >
      {children}
    </LibraryFrame>
  );
}
