'use client';

import { useEffect } from 'react';

const EPUB_KEY_EVENT = 'openreader:epub-keydown';

/** EPUB keyboard events stay inside its frame. Preserve the original target
 * and cancellation state so the same shortcut policy applies in every reader. */
export function relayEpubKeyDown(event: KeyboardEvent) {
  window.dispatchEvent(new CustomEvent(EPUB_KEY_EVENT, { detail: event }));
}

export function usePlaybackKeyboardControls({
  togglePlay, skipBackward, skipForward, changeSpeed, openHelp,
  canToggle, canSkip, canChangeSpeed,
}: {
  togglePlay: () => void;
  skipBackward: () => void;
  skipForward: () => void;
  changeSpeed: (direction: number) => void;
  openHelp: () => void;
  canToggle: boolean;
  canSkip: boolean;
  canChangeSpeed: boolean;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing
        || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as Element | null;
      // Structural check works for elements belonging to an EPUB frame too.
      if (typeof target?.closest === 'function'
        && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"]')) return;
      // Non-modal reader panels keep shortcuts; a modal, menu or listbox owns the keyboard.
      if (document.querySelector('[aria-modal="true"]:not([data-closing]), [role="menu"], [role="listbox"]')) return;

      let action: (() => void) | undefined;
      if (event.code === 'Space' && canToggle) action = togglePlay;
      if (event.key === 'ArrowLeft' && canSkip) action = skipBackward;
      if (event.key === 'ArrowRight' && canSkip) action = skipForward;
      if (event.key === 'ArrowUp' && canChangeSpeed) action = () => changeSpeed(1);
      if (event.key === 'ArrowDown' && canChangeSpeed) action = () => changeSpeed(-1);
      if (event.code === 'KeyK') action = openHelp;
      if (!action) return;
      event.preventDefault();
      action();
    };
    const onEpubKeyDown = (event: Event) => onKeyDown((event as CustomEvent<KeyboardEvent>).detail);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(EPUB_KEY_EVENT, onEpubKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(EPUB_KEY_EVENT, onEpubKeyDown);
    };
  }, [togglePlay, skipBackward, skipForward, changeSpeed, openHelp, canToggle, canSkip, canChangeSpeed]);
}
