'use client';

import { clearRangeHighlight, paintRangeHighlight } from '@/lib/client/highlight-range-painter';
import {
  createTapGuard,
  SEEK_HOVER_DECLARATIONS,
  SEEK_HOVER_HIGHLIGHT,
} from '@/lib/client/reader/segment-hit';

export type TapSeekTarget = {
  ordinal: number;
  /** The rendered extent of the sentence, painted as the hover affordance. */
  range: Range | null;
};

export type TapSeekPoint = {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
};

export type TapToSeekOptions = {
  /** Resolve a point to the plan segment a tap there would seek to. */
  resolve: (point: TapSeekPoint) => TapSeekTarget | null;
  seek: (ordinal: number) => void;
};

/**
 * Bind tap-to-seek and its hover affordance to a reader surface (an element of
 * the app document, or an EPUB section document). The reader owns hit testing;
 * this owns the gesture: taps seek, drags/selections/links do not, and a
 * pointer over seekable text shows which sentence a tap would play.
 */
export function bindTapToSeek(
  surface: HTMLElement | Document,
  { resolve, seek }: TapToSeekOptions,
): () => void {
  // Compare node types rather than `instanceof`: EPUB sections live in iframes
  // with their own Document constructor.
  const isDocument = surface.nodeType === 9;
  const doc = isDocument ? surface as Document : (surface as HTMLElement).ownerDocument;
  const cursorHost = (isDocument ? doc.body : surface) as HTMLElement | null;
  const leaveHost: EventTarget = isDocument ? doc.documentElement : surface;
  const guard = createTapGuard();
  let frame = 0;
  let pending: TapSeekPoint | null = null;
  let hovered: number | null = null;

  const clearHover = () => {
    if (hovered === null) return;
    hovered = null;
    clearRangeHighlight(doc, SEEK_HOVER_HIGHLIGHT);
    if (cursorHost) cursorHost.style.cursor = '';
  };

  const applyHover = () => {
    frame = 0;
    const point = pending;
    pending = null;
    if (!point) return;
    const hit = resolve(point);
    if (!hit) {
      clearHover();
      return;
    }
    if (hit.ordinal === hovered) return;
    hovered = hit.ordinal;
    if (hit.range) paintRangeHighlight(hit.range, SEEK_HOVER_HIGHLIGHT, SEEK_HOVER_DECLARATIONS);
    else clearRangeHighlight(doc, SEEK_HOVER_HIGHLIGHT);
    if (cursorHost) cursorHost.style.cursor = 'pointer';
  };

  const onPointerDown = (event: Event) => guard.pointerDown(event as PointerEvent);
  const onClick = (event: Event) => {
    const mouse = event as MouseEvent;
    if (!guard.isTap(mouse)) return;
    const hit = resolve(mouse);
    if (!hit) return;
    clearHover();
    seek(hit.ordinal);
  };
  const onMouseMove = (event: Event) => {
    const mouse = event as MouseEvent;
    // Buttons held means a drag or a selection in progress, never a tap.
    if (mouse.buttons !== 0) {
      clearHover();
      return;
    }
    pending = { clientX: mouse.clientX, clientY: mouse.clientY, target: mouse.target };
    if (!frame) frame = (doc.defaultView ?? window).requestAnimationFrame(applyHover);
  };

  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('click', onClick);
  surface.addEventListener('mousemove', onMouseMove);
  leaveHost.addEventListener('mouseleave', clearHover);
  return () => {
    if (frame) (doc.defaultView ?? window).cancelAnimationFrame(frame);
    surface.removeEventListener('pointerdown', onPointerDown);
    surface.removeEventListener('click', onClick);
    surface.removeEventListener('mousemove', onMouseMove);
    leaveHost.removeEventListener('mouseleave', clearHover);
    clearHover();
  };
}
