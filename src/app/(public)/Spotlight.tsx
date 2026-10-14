'use client';

import type { ReactNode } from 'react';

/** Tracks the pointer as `--mx`/`--my` on each card so borders can glow under it. */
export function Spotlight({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div
      className={className}
      onPointerMove={(event) => {
        for (const card of event.currentTarget.children) {
          const el = card as HTMLElement;
          const rect = el.getBoundingClientRect();
          el.style.setProperty('--mx', `${event.clientX - rect.left}px`);
          el.style.setProperty('--my', `${event.clientY - rect.top}px`);
        }
      }}
    >
      {children}
    </div>
  );
}
