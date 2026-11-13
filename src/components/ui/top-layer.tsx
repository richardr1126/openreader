'use client';

import { useEffect, useRef, type ReactNode } from 'react';

const raisers = new Set<() => void>();

/** Called by a modal as it opens, so content that belongs above every modal stays there. */
export function raiseAboveModals() {
  for (const raise of raisers) raise();
}

/**
 * Keeps passive overlays such as toasts above open modal dialogs. A modal sits
 * in the browser's top layer, which no z-index outranks, so this content joins
 * the top layer as a manual popover and moves back to its top whenever a modal
 * opens. Content here is for reading only: an open modal keeps it inert.
 */
export function AboveModals({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = ref.current;
    // Without the Popover API the content still shows, beneath any open modal.
    if (!layer || typeof layer.showPopover !== 'function') return;
    const raise = () => {
      if (layer.matches(':popover-open')) layer.hidePopover();
      layer.showPopover();
    };
    raise();
    raisers.add(raise);
    return () => {
      raisers.delete(raise);
      if (layer.matches(':popover-open')) layer.hidePopover();
    };
  }, []);

  return (
    <div ref={ref} popover="manual" className="m-0 h-0 w-0 overflow-visible border-0 bg-transparent p-0">
      {children}
    </div>
  );
}
