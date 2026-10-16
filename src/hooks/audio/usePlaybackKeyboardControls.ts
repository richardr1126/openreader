'use client';

import { useEffect } from 'react';

const EPUB_KEY_EVENT = 'openreader:epub-keydown';

/** EPUB keyboard events stay inside its frame. Preserve the original target
 * and cancellation state so the same shortcut policy applies in every reader. */
export function relayEpubKeyDown(event: KeyboardEvent) {
  window.dispatchEvent(new CustomEvent(EPUB_KEY_EVENT, { detail: event }));
}

/** Keys typed here belong to the field. */
const EDITING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';
/** Controls whose own arrow keys move a value or selection. */
const ARROW_OWNERS = '[role="slider"], [role="radiogroup"], [role="radio"], [role="tablist"], [role="separator"]';
/** Controls that Space activates. */
const SPACE_OWNERS = 'button, a[href], summary, [role="button"], [role="checkbox"], [role="switch"], [role="link"], [role="tab"], [role="radio"]';

export function usePlaybackKeyboardControls({
  enabled, togglePlay, skipBackward, skipForward, changeSpeed,
  canToggle, canSkip, canChangeSpeed,
}: {
  enabled: boolean;
  togglePlay: () => void;
  skipBackward: () => void;
  skipForward: () => void;
  changeSpeed: (direction: number) => void;
  canToggle: boolean;
  canSkip: boolean;
  canChangeSpeed: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing
        || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as Element | null;
      // Structural checks work for elements belonging to an EPUB frame too.
      const within = (selector: string) => typeof target?.closest === 'function' && target.closest(selector) !== null;
      if (within(EDITING)) return;
      if (document.querySelector('[aria-modal="true"]:not([data-closing]), [role="menu"], [role="listbox"]')) return;

      let action: (() => void) | undefined;
      switch (event.key) {
        case ' ':
          if (canToggle && !within(SPACE_OWNERS)) action = togglePlay;
          break;
        case 'ArrowLeft':
          if (canSkip && !event.shiftKey && !within(ARROW_OWNERS)) action = skipBackward;
          break;
        case 'ArrowRight':
          if (canSkip && !event.shiftKey && !within(ARROW_OWNERS)) action = skipForward;
          break;
        case '<':
          if (canChangeSpeed) action = () => changeSpeed(-1);
          break;
        case '>':
          if (canChangeSpeed) action = () => changeSpeed(1);
          break;
      }
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
  }, [enabled, togglePlay, skipBackward, skipForward, changeSpeed, canToggle, canSkip, canChangeSpeed]);
}
