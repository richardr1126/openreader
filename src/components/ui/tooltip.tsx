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

/** One of several actions a combined control opens, listed under the label. */
export interface TooltipItem {
  icon?: ReactNode;
  label: string;
  shortcut?: string;
}

const OPEN_DELAY_MS = 450;
/** Moving between controls soon after a tooltip closes shows the next one at once. */
const WARM_WINDOW_MS = 400;
const GAP_PX = 8;
const ARROW_INSET_PX = 12;
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

function KeyHint({ children }: { children: string }) {
  return (
    <kbd className="ml-auto rounded border border-line-soft bg-surface-sunken px-1 font-sans text-[10px] font-medium leading-4 text-soft">
      {children}
    </kbd>
  );
}

/**
 * A hover and keyboard-focus label for one control. A control that opens
 * several actions passes `items`, so the card previews what is inside it. The wrapper is
 * layout-neutral (`display: contents`), so it can sit inside flex, grid and
 * headless-ui trigger compositions without changing them. The label mirrors
 * the control's accessible name, which stays on the control itself.
 */
export function Tooltip({
  label,
  shortcut,
  items,
  side = 'bottom',
  children,
}: {
  label: ReactNode;
  /** Shown as a key hint after the label, e.g. "Space" or "Esc". */
  shortcut?: string;
  items?: readonly TooltipItem[];
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
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    below: boolean;
    /** The arrow's offset inside the card, so it points at a clamped anchor. */
    arrowLeft: number;
  } | null>(null);

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
    const anchorCentre = a.left + a.width / 2;
    const maxLeft = window.innerWidth - VIEWPORT_MARGIN_PX - t.width;
    const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(anchorCentre - t.width / 2, maxLeft));
    setPosition({
      left,
      top: placeBelow ? a.bottom + GAP_PX : a.top - GAP_PX - t.height,
      below: placeBelow,
      arrowLeft: Math.max(ARROW_INSET_PX, Math.min(anchorCentre - left, t.width - ARROW_INSET_PX)),
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
          style={position ? { left: position.left, top: position.top } : { left: 0, top: 0 }}
          className={cn(
            'pointer-events-none fixed z-[100] max-w-72 rounded-md border border-line bg-surface-solid text-[11px] leading-tight text-foreground shadow-elev-3',
            'transition-[opacity,transform] duration-fast ease-standard motion-reduce:transition-none',
            position?.below ? 'origin-top' : 'origin-bottom',
            position ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
          )}
        >
          {/* A rotated square sharing the card's border, pointing at the control. */}
          {position ? (
            <span
              aria-hidden
              className={cn(
                'absolute h-2 w-2 -translate-x-1/2 rotate-45 border-line bg-surface-solid',
                position.below ? '-top-[5px] border-l border-t' : '-bottom-[5px] border-b border-r',
              )}
              style={{ left: position.arrowLeft }}
            />
          ) : null}
          <div className="relative flex items-center gap-2 px-2.5 py-1.5 font-medium">
            <span className={items?.length ? 'font-semibold' : undefined}>{label}</span>
            {shortcut ? <KeyHint>{shortcut}</KeyHint> : null}
          </div>
          {items?.length ? (
            <ul className="relative space-y-0.5 border-t border-line-soft px-1.5 py-1.5">
              {items.map((item) => (
                <li key={item.label} className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-soft">
                  {item.icon ? (
                    <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-surface-sunken text-foreground [&_svg]:h-3 [&_svg]:w-3">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="whitespace-nowrap">{item.label}</span>
                  {item.shortcut ? <KeyHint>{item.shortcut}</KeyHint> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>,
        document.body,
      )}
    </span>
  );
}
