'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

export type TooltipSide = 'top' | 'bottom';

const OPEN_DELAY_MS = 450;
/** Moving between controls soon after a tooltip closes shows the next one at once. */
const WARM_WINDOW_MS = 400;
const GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 8;

let lastClosedAt = 0;

function anchorOf(wrapper: HTMLElement | null): HTMLElement | null {
  const child = wrapper?.firstElementChild;
  return child instanceof HTMLElement ? child : null;
}

/** Popups own the space under their trigger while open. */
function anchorIsExpanded(anchor: HTMLElement) {
  return anchor.getAttribute('aria-expanded') === 'true';
}

/**
 * A hover and keyboard-focus label for one control. The wrapper is
 * layout-neutral (`display: contents`), so it can sit inside flex, grid and
 * headless-ui trigger compositions without changing them. The label mirrors
 * the control's accessible name, which stays on the control itself.
 */
export function Tooltip({
  label,
  shortcut,
  side = 'bottom',
  children,
}: {
  label: ReactNode;
  /** Shown as a key hint after the label, e.g. "Space" or "Esc". */
  shortcut?: string;
  side?: TooltipSide;
  children: ReactElement;
}) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const hide = useCallback(() => {
    clearTimer();
    if (openRef.current) lastClosedAt = Date.now();
    setOpen(false);
    setPosition(null);
  }, []);

  const scheduleShow = () => {
    const anchor = anchorOf(wrapperRef.current);
    if (!anchor || anchorIsExpanded(anchor)) return;
    clearTimer();
    if (Date.now() - lastClosedAt < WARM_WINDOW_MS) {
      setOpen(true);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const current = anchorOf(wrapperRef.current);
      if (current && !anchorIsExpanded(current)) setOpen(true);
    }, OPEN_DELAY_MS);
  };

  const handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    const from = event.relatedTarget as Node | null;
    if (from && wrapperRef.current?.contains(from)) return;
    scheduleShow();
  };

  const handlePointerOut = (event: PointerEvent) => {
    const to = event.relatedTarget as Node | null;
    if (to && wrapperRef.current?.contains(to)) return;
    hide();
  };

  const handleFocus = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement && event.target.matches(':focus-visible')) scheduleShow();
  };

  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorOf(wrapperRef.current);
    const tip = tooltipRef.current;
    if (!anchor || !tip || !anchor.isConnected) {
      hide();
      return;
    }
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const fitsBelow = a.bottom + GAP_PX + t.height <= window.innerHeight - VIEWPORT_MARGIN_PX;
    const fitsAbove = a.top - GAP_PX - t.height >= VIEWPORT_MARGIN_PX;
    const placeBelow = side === 'bottom' ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;
    const centred = a.left + a.width / 2 - t.width / 2;
    const maxLeft = window.innerWidth - VIEWPORT_MARGIN_PX - t.width;
    setPosition({
      left: Math.max(VIEWPORT_MARGIN_PX, Math.min(centred, maxLeft)),
      top: placeBelow ? a.bottom + GAP_PX : a.top - GAP_PX - t.height,
    });
  }, [open, side, hide]);

  return (
    <span
      ref={wrapperRef}
      className="contents"
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      onPointerDown={hide}
      onFocus={handleFocus}
      onBlur={hide}
    >
      {children}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          style={position ?? { left: 0, top: 0 }}
          className={cn(
            'pointer-events-none fixed z-[100] flex max-w-64 items-center gap-1.5 rounded-sm border border-line bg-surface-solid px-2 py-1 text-[11px] font-medium leading-tight text-foreground shadow-elev-2',
            'transition-opacity duration-fast ease-standard',
            position ? 'opacity-100' : 'opacity-0',
          )}
        >
          <span>{label}</span>
          {shortcut ? (
            <kbd className="rounded border border-line-soft bg-surface-sunken px-1 font-sans text-[10px] font-medium leading-4 text-soft">
              {shortcut}
            </kbd>
          ) : null}
        </div>,
        document.body,
      )}
    </span>
  );
}
