'use client';

import { Button, ModalFrame, ModalTitle } from '@/components/ui';

const shortcuts = [
  ['Alt + Shift + Space', 'Play, pause, or cancel loading'],
  ['Alt + Shift + ← / →', 'Skip backward / forward'],
  ['Alt + Shift + ↑ / ↓', 'Increase / decrease playback speed'],
  ['Alt + Shift + K', 'Open keyboard shortcuts'],
];

export function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ModalFrame open={open} onClose={onClose} size="lg">
      <ModalTitle>Keyboard shortcuts</ModalTitle>
      <p className="mt-2 text-sm text-soft">
        On Mac, Alt is Option. Playback shortcuts work in every reader, including inside EPUB text.
        They are inactive while editing fields or using a dialog or menu.
      </p>
      <dl className="mt-4 divide-y divide-line-soft text-sm">
        {shortcuts.map(([keys, action]) => (
          <div key={keys} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <dt>{action}</dt>
            <dd><kbd className="rounded border border-line bg-surface-sunken px-2 py-1 text-xs">{keys}</kbd></dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm text-soft">
        Use Tab and Shift+Tab to move between controls, then Enter or Space to activate buttons.
        On the playback position slider, use arrow keys, Home, or End to seek.
        Escape closes dialogs and reader panels and returns focus to their opener.
      </p>
      <div className="mt-5 flex justify-end"><Button onClick={onClose}>Close keyboard shortcuts</Button></div>
    </ModalFrame>
  );
}
