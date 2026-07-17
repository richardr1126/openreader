import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

import type { TTSSegmentLocator } from '@/types/client';
import { isPdfLocator, isStableEpubLocator } from '@/types/client';
import type { TTSLocation } from '@/types/tts';
import type { ReaderType } from '@/types/user-state';

export type PlaybackAnchor = {
  text: string;
  location: TTSLocation;
  locator: TTSSegmentLocator | null;
  hasContent: boolean;
};

export type PlaybackStartLocation = {
  page?: TTSLocation;
  spineIndex?: number;
  charOffset?: number;
};

export function pdfLocatorPage(locator: TTSSegmentLocator | null | undefined): number | null {
  return isPdfLocator(locator) ? Math.max(1, Math.floor(locator.page)) : null;
}

export function pdfAnchorPage(location: TTSLocation | undefined): number | null {
  return typeof location === 'number' && Number.isFinite(location)
    ? Math.max(1, Math.floor(location))
    : null;
}

export function resolveFirstPlanIndexForPdfPage(
  plan: CanonicalTtsSegment[],
  page: number | undefined,
): number {
  if (typeof page !== 'number' || !Number.isFinite(page)) return -1;
  const targetPage = Math.max(1, Math.floor(page));
  return plan.findIndex((segment) => pdfLocatorPage(segment.ownerLocator) === targetPage);
}

export function resolveFirstPlanIndexForDocumentAnchor(
  plan: CanonicalTtsSegment[],
  readerType: ReaderType,
  location: TTSLocation,
): number {
  if (readerType === 'pdf') {
    const page = pdfAnchorPage(location);
    return page === null ? -1 : resolveFirstPlanIndexForPdfPage(plan, page);
  }
  if (readerType === 'html') {
    const locationKey = String(location || '1');
    return plan.findIndex((segment) => {
      const locator = segment.ownerLocator;
      return locator?.readerType === 'html' && String(locator.location || '1') === locationKey;
    });
  }
  return -1;
}

export function resolvePlaybackAnchorLocation(input: {
  anchor: PlaybackAnchor | null;
  readerType: ReaderType;
  currentLocation: TTSLocation;
  currentPdfPage: number;
}): PlaybackStartLocation {
  const { anchor, readerType, currentLocation, currentPdfPage } = input;
  if (readerType === 'pdf') {
    const page = pdfAnchorPage(anchor?.location) ?? pdfAnchorPage(currentPdfPage);
    return page === null ? {} : { page };
  }
  if (readerType === 'html') {
    return { page: (anchor?.location ?? currentLocation) || '1' };
  }
  if (readerType === 'epub') {
    const locator = isStableEpubLocator(anchor?.locator) ? anchor.locator : null;
    if (!locator) return {};
    const charOffset = typeof locator.charOffset === 'number' && Number.isFinite(locator.charOffset)
      ? Math.max(0, Math.floor(locator.charOffset))
      : null;
    if (charOffset === null) return {};
    return {
      spineIndex: Math.max(0, locator.spineIndex),
      charOffset,
    };
  }
  return {};
}

export function resolvePlanBackedSelectionIndex(input: {
  plan: CanonicalTtsSegment[];
  readerType: ReaderType;
  selectedOrdinal?: number | null;
  anchorLocation: PlaybackStartLocation;
}): number {
  if (input.plan.length === 0) return -1;
  if (typeof input.selectedOrdinal === 'number' && Number.isFinite(input.selectedOrdinal)) {
    return input.plan.findIndex(
      (segment) => segment.ordinal === Math.max(0, Math.floor(input.selectedOrdinal!)),
    );
  }

  if (input.readerType === 'pdf') {
    const page = typeof input.anchorLocation.page === 'number' ? input.anchorLocation.page : undefined;
    return resolveFirstPlanIndexForPdfPage(input.plan, page);
  }

  if (input.readerType === 'html') {
    const locationKey = String(input.anchorLocation.page ?? '1');
    return input.plan.findIndex((segment) => {
      const locator = segment.ownerLocator;
      return locator?.readerType === 'html' && String(locator.location || '1') === locationKey;
    });
  }

  if (input.readerType === 'epub') {
    if (
      typeof input.anchorLocation.spineIndex !== 'number'
      || typeof input.anchorLocation.charOffset !== 'number'
    ) {
      return -1;
    }
    return input.plan.findIndex((segment) => {
      const locator = segment.ownerLocator;
      if (locator?.readerType !== 'epub' || typeof locator.spineIndex !== 'number') return false;
      if (locator.spineIndex > input.anchorLocation.spineIndex!) return true;
      if (locator.spineIndex < input.anchorLocation.spineIndex!) return false;
      return typeof locator.charOffset !== 'number'
        || locator.charOffset >= input.anchorLocation.charOffset!;
    });
  }

  return -1;
}
