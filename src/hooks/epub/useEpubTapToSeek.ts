'use client';

import { useEffect, useMemo, type MutableRefObject } from 'react';
import type { Contents, Rendition } from 'epubjs';
import { useTTS } from '@/contexts/TTSContext';
import { useLatestRef } from '@/hooks/useLatestRef';
import type { EpubRenderedTextMap } from '@/lib/client/epub/epub-rendered-text-maps';
import { indexEpubSegmentSpans, resolveEpubPointHit } from '@/lib/client/epub/epub-segment-hit';
import { bindTapToSeek } from '@/lib/client/reader/tap-to-seek';

/**
 * Tap a sentence in a rendered EPUB section to play from it. Each section
 * iframe document is bound as it is rendered; hit testing reads the same
 * committed rendered text maps the sentence highlight paints from.
 */
export function useEpubTapToSeek({
  renditionRef,
  renditionGeneration,
  renderedTextMapsRef,
}: {
  renditionRef: MutableRefObject<Rendition | undefined>;
  renditionGeneration: number;
  renderedTextMapsRef: MutableRefObject<EpubRenderedTextMap[]>;
}) {
  const { playbackSegments, skipToOrdinal } = useTTS();
  const spansBySpine = useMemo(() => indexEpubSegmentSpans(playbackSegments), [playbackSegments]);
  const stateRef = useLatestRef({ spansBySpine, skipToOrdinal });

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    const unbinders = new Map<Document, () => void>();
    const bind = (contents: Contents) => {
      const doc = contents?.document;
      if (!doc || unbinders.has(doc)) return;
      // Sections unload as the reader pages; drop documents whose iframe is gone.
      unbinders.forEach((unbind, bound) => {
        if (bound.defaultView) return;
        unbind();
        unbinders.delete(bound);
      });
      unbinders.set(doc, bindTapToSeek(doc, {
        resolve: (point) => resolveEpubPointHit(
          renderedTextMapsRef.current,
          stateRef.current.spansBySpine,
          doc,
          point,
        ),
        seek: (ordinal) => {
          stateRef.current.skipToOrdinal(ordinal);
        },
      }));
    };
    const current = rendition.getContents() as unknown as Contents | Contents[];
    (Array.isArray(current) ? current : [current]).forEach(bind);
    rendition.hooks.content.register(bind);
    return () => {
      rendition.hooks.content.deregister(bind);
      unbinders.forEach((unbind) => unbind());
      unbinders.clear();
    };
  }, [renditionGeneration, renditionRef, renderedTextMapsRef, stateRef]);
}
