import { describe, expect, test } from 'vitest';

import {
  pdfAnchorPage,
  resolveFirstPlanIndexForDocumentAnchor,
  resolvePlanBackedSelectionIndex,
  resolvePlaybackAnchorLocation,
} from '@/lib/client/tts/playback-selection';
import type { TTSSegmentLocator } from '@/types/client';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

function segment(ordinal: number, locator: TTSSegmentLocator): CanonicalTtsSegment {
  return {
    key: `segment-${ordinal}`,
    ordinal,
    text: `Sentence ${ordinal}`,
    ownerSourceKey: `source-${ordinal}`,
    ownerLocator: locator,
    startAnchor: { sourceKey: `source-${ordinal}`, offset: 0 },
    endAnchor: { sourceKey: `source-${ordinal}`, offset: 12 },
    spansSourceBoundary: false,
  };
}

describe('playback plan selection', () => {
  test('keeps PDF anchors numeric and selects the first segment on the page', () => {
    const plan = [
      segment(0, { readerType: 'pdf', page: 1 }),
      segment(1, { readerType: 'pdf', page: 3 }),
      segment(2, { readerType: 'pdf', page: 3 }),
    ];

    expect(pdfAnchorPage('3')).toBeNull();
    expect(resolveFirstPlanIndexForDocumentAnchor(plan, 'pdf', 3)).toBe(1);
    expect(resolveFirstPlanIndexForDocumentAnchor(plan, 'pdf', '3')).toBe(-1);
  });

  test('prefers an existing canonical ordinal over the viewport anchor', () => {
    const plan = [
      segment(4, { readerType: 'html', location: 'intro' }),
      segment(7, { readerType: 'html', location: 'body' }),
    ];

    expect(resolvePlanBackedSelectionIndex({
      plan,
      readerType: 'html',
      selectedOrdinal: 7,
      anchorLocation: { page: 'intro' },
    })).toBe(1);
  });

  test('resolves EPUB starts from stable spine coordinates', () => {
    const anchor = {
      text: 'Visible text',
      location: 'epubcfi(/6/4)',
      locator: {
        readerType: 'epub' as const,
        spineIndex: 2,
        spineHref: 'chapter-2.xhtml',
        charOffset: 35,
      },
      hasContent: true,
    };
    const start = resolvePlaybackAnchorLocation({
      anchor,
      readerType: 'epub',
      currentLocation: anchor.location,
      currentPdfPage: 1,
    });
    const plan = [
      segment(0, { readerType: 'epub', spineIndex: 2, spineHref: 'chapter-2.xhtml', charOffset: 10 }),
      segment(1, { readerType: 'epub', spineIndex: 2, spineHref: 'chapter-2.xhtml', charOffset: 40 }),
      segment(2, { readerType: 'epub', spineIndex: 3, spineHref: 'chapter-3.xhtml', charOffset: 0 }),
    ];

    expect(start).toEqual({ spineIndex: 2, charOffset: 35 });
    expect(resolvePlanBackedSelectionIndex({
      plan,
      readerType: 'epub',
      anchorLocation: start,
    })).toBe(1);
  });
});
