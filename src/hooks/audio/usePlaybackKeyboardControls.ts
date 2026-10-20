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

type Within = (selector: string) => boolean;

/** Applies the shared shortcut policy, in the page and relayed from an EPUB
 * frame, and runs the action `resolve` picks for an eligible key press. */
function listenForReaderKeys(resolve: (event: KeyboardEvent, within: Within) => (() => void) | undefined) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing
      || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as Element | null;
    // Structural checks work for elements belonging to an EPUB frame too.
    const within: Within = (selector) => typeof target?.closest === 'function' && target.closest(selector) !== null;
    if (within(EDITING)) return;
    if (document.querySelector('[aria-modal="true"]:not([data-closing]), [role="menu"], [role="listbox"]')) return;
    const action = resolve(event, within);
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
}

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
    return listenForReaderKeys((event, within) => {
      switch (event.key) {
        case ' ':
          return canToggle && !within(SPACE_OWNERS) ? togglePlay : undefined;
        case 'ArrowLeft':
          return canSkip && !event.shiftKey && !within(ARROW_OWNERS) ? skipBackward : undefined;
        case 'ArrowRight':
          return canSkip && !event.shiftKey && !within(ARROW_OWNERS) ? skipForward : undefined;
        case '<':
          return canChangeSpeed ? () => changeSpeed(-1) : undefined;
        case '>':
          return canChangeSpeed ? () => changeSpeed(1) : undefined;
      }
    });
  }, [enabled, togglePlay, skipBackward, skipForward, changeSpeed, canToggle, canSkip, canChangeSpeed]);
}

/** Shift with an arrow turns the page or section; a plain arrow skips a sentence. */
export function usePageTurnKeyboardControls({
  enabled, onPrevious, onNext, canPrevious, canNext,
}: {
  enabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious: boolean;
  canNext: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    return listenForReaderKeys((event, within) => {
      if (!event.shiftKey || within(ARROW_OWNERS)) return undefined;
      if (event.key === 'ArrowLeft') return canPrevious ? onPrevious : undefined;
      if (event.key === 'ArrowRight') return canNext ? onNext : undefined;
      return undefined;
    });
  }, [enabled, onPrevious, onNext, canPrevious, canNext]);
}
