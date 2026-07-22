import { describe, expect, test } from 'vitest';

import {
  pdfAnchorPage,
  resolveEpubPlanBackedSelection,
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

    expect(start).toEqual({ spineHref: 'chapter-2.xhtml', spineIndex: 2, charOffset: 35 });
    expect(resolvePlanBackedSelectionIndex({
      plan,
      readerType: 'epub',
      anchorLocation: start,
    })).toBe(1);
  });

  test('makes EPUB placement authoritative-plan-only', () => {
    const plan = [
      segment(12, { readerType: 'epub', spineIndex: 4, spineHref: 'chapter-4.xhtml', charOffset: 20 }),
      segment(13, { readerType: 'epub', spineIndex: 4, spineHref: 'chapter-4.xhtml', charOffset: 80 }),
    ];

    expect(resolveEpubPlanBackedSelection({
      plan,
      locator: {
        readerType: 'epub',
        spineIndex: 4,
        spineHref: 'chapter-4.xhtml',
        charOffset: 50,
        cfi: 'epubcfi(/6/8!/4:50)',
      },
    })).toEqual({ status: 'selected', index: 1, ordinal: 13 });
    expect(resolveEpubPlanBackedSelection({
      plan,
      locator: { readerType: 'epub', cfi: 'epubcfi(/6/8!/4:50)' },
    })).toEqual({ status: 'invalid-anchor' });
    expect(resolveEpubPlanBackedSelection({
      plan,
      locator: {
        readerType: 'epub',
        spineIndex: 9,
        spineHref: 'after-the-book.xhtml',
        charOffset: 0,
      },
    })).toEqual({ status: 'unmapped-anchor' });
    expect(resolveEpubPlanBackedSelection({
      plan,
      locator: {
        readerType: 'epub',
        spineIndex: 4,
        spineHref: 'different-chapter.xhtml',
        charOffset: 50,
      },
    })).toEqual({ status: 'unmapped-anchor' });
    expect(resolveEpubPlanBackedSelection({ plan: [], locator: null }))
      .toEqual({ status: 'empty-plan' });
  });

  test('resolves the same stable EPUB position across plan variants without trusting ordinals', () => {
    const locator = {
      readerType: 'epub' as const,
      spineIndex: 1,
      spineHref: 'chapter-1.xhtml',
      charOffset: 75,
    };
    const shortPlan = [
      segment(2, { ...locator, charOffset: 0 }),
      segment(3, { ...locator, charOffset: 100 }),
    ];
    const detailedPlan = [
      segment(20, { ...locator, charOffset: 0 }),
      segment(21, { ...locator, charOffset: 50 }),
      segment(22, { ...locator, charOffset: 90 }),
    ];

    expect(resolveEpubPlanBackedSelection({ plan: shortPlan, locator }))
      .toEqual({ status: 'selected', index: 1, ordinal: 3 });
    expect(resolveEpubPlanBackedSelection({ plan: detailedPlan, locator }))
      .toEqual({ status: 'selected', index: 2, ordinal: 22 });
  });
});
