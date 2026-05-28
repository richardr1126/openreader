'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { TouchBackend } from 'react-dnd-touch-backend';

const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

function detectTouchInitial(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia(TOUCH_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * DnD provider that swaps between HTML5 (mouse/keyboard) and Touch backends
 * based on the primary input device. Long-press activates a drag on touch.
 *
 * react-dnd doesn't allow swapping backends after mount, so the subtree is
 * remounted with a `key` when the media query changes. That happens at most
 * when the user docks/undocks a tablet — fine in practice.
 */
export function DocumentDndProvider({ children }: { children: ReactNode }) {
  const [isTouch, setIsTouch] = useState<boolean>(detectTouchInitial);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(TOUCH_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (isTouch) {
    return (
      <DndProvider
        key="touch"
        backend={TouchBackend}
        options={{
          enableMouseEvents: false,
          enableTouchEvents: true,
          delayTouchStart: 220,
          ignoreContextMenu: true,
        }}
      >
        {children}
      </DndProvider>
    );
  }

  return (
    <DndProvider key="html5" backend={HTML5Backend}>
      {children}
    </DndProvider>
  );
}
