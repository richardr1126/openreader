import { locatorGroupKey } from '@openreader/tts/locator';
import { normalizeLocator } from '@openreader/tts/segments';
import type { TTSSegmentLocator } from '@openreader/tts/types';
import { isHtmlLocator, isPdfLocator, isStableEpubLocator } from '@openreader/tts/types';
import type { TtsPlaybackSegmentInput } from './plan';

/**
 * One export chapter: a contiguous run of plan segments sharing a locator
 * group (EPUB spine item, PDF page, or HTML section). The chapter list, the
 * per-chapter download, and M4B chapter markers all use this grouping.
 */
export type ExportChapterGroup = {
  index: number;
  title: string;
  ordinals: number[];
  spineHref: string | null;
  page: number | null;
};

function fallbackChapterTitle(locator: TTSSegmentLocator | null, index: number): string {
  if (isPdfLocator(locator)) return `Page ${Math.max(1, Math.floor(locator.page))}`;
  if (isStableEpubLocator(locator)) return `Chapter ${index}`;
  if (isHtmlLocator(locator)) return index === 1 ? 'Document' : `Section ${index}`;
  return `Chapter ${index}`;
}

export function groupExportChapters(segments: TtsPlaybackSegmentInput[]): ExportChapterGroup[] {
  const chapters: ExportChapterGroup[] = [];
  let activeGroup: string | null = null;
  for (const segment of segments) {
    const locator = normalizeLocator(segment.locator as never);
    const group = locatorGroupKey(locator);
    if (group !== activeGroup) {
      activeGroup = group;
      chapters.push({
        index: chapters.length,
        title: fallbackChapterTitle(locator, chapters.length + 1),
        ordinals: [],
        spineHref: isStableEpubLocator(locator) ? locator.spineHref : null,
        page: isPdfLocator(locator) ? Math.max(1, Math.floor(locator.page)) : null,
      });
    }
    chapters[chapters.length - 1]!.ordinals.push(segment.ordinal);
  }
  return chapters;
}
