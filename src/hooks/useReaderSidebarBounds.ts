'use client';

import { useEffect, useState } from 'react';

interface ReaderSidebarBounds {
  top: number;
  bottom: number;
}

export function useReaderSidebarBounds(isOpen: boolean): ReaderSidebarBounds {
  const [bounds, setBounds] = useState<ReaderSidebarBounds>({ top: 0, bottom: 0 });

  useEffect(() => {
    if (!isOpen) return;

    const computeBounds = () => {
      const header = document.querySelector('[data-app-header]') as HTMLElement | null;
      const toolbar = document.querySelector('[data-reader-toolbar]') as HTMLElement | null;
      const ttsbar = document.querySelector('[data-app-ttsbar]') as HTMLElement | null;
      const contentTop = Math.ceil(Math.max(
        header?.getBoundingClientRect().bottom ?? 0,
        toolbar?.getBoundingClientRect().bottom ?? 0,
      ));
      const ttsH = ttsbar ? Math.ceil(ttsbar.getBoundingClientRect().height) : 0;
      setBounds({ top: contentTop, bottom: ttsH });
    };

    computeBounds();
    window.addEventListener('resize', computeBounds);
    return () => window.removeEventListener('resize', computeBounds);
  }, [isOpen]);

  return bounds;
}
