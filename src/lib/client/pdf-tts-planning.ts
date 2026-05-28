import type { CanonicalTtsSourceUnit } from '@/lib/shared/tts-segment-plan';
import type { TTSSegmentLocator } from '@/types/client';
import type { ParsedPdfBlockKind, ParsedPdfPage } from '@/types/parsed-pdf';

type PdfUpcomingLocation = {
  location: number;
  text: string;
  sourceUnits: CanonicalTtsSourceUnit[];
};

export function buildPdfPageSourceUnits(
  page: ParsedPdfPage | undefined,
  pageNum: number,
  skipKinds: ParsedPdfBlockKind[] = [],
): CanonicalTtsSourceUnit[] {
  if (!page) return [];
  const skip = new Set(skipKinds);
  return page.blocks
    .filter((block) => !skip.has(block.kind))
    .map((block) => ({
      sourceKey: `pdf:${pageNum}:${block.id}`,
      text: block.text,
      locator: {
        readerType: 'pdf',
        page: pageNum,
        blockId: block.id,
      } as TTSSegmentLocator,
    }))
    .filter((unit) => unit.text.trim().length > 0);
}

export function buildPdfPrefetchPayload(
  upcomingPageNumbers: number[],
  upcomingTexts: string[],
  sourceUnitsForPage: (pageNum: number) => CanonicalTtsSourceUnit[],
): {
  nextText: string | undefined;
  nextSourceUnits: CanonicalTtsSourceUnit[];
  additionalUpcoming: PdfUpcomingLocation[];
} {
  const nextPageNumber = upcomingPageNumbers[0];
  const nextText = upcomingTexts[0];
  const nextSourceUnits = nextPageNumber ? sourceUnitsForPage(nextPageNumber) : [];
  const additionalUpcoming = upcomingPageNumbers
    .slice(1)
    .map((pageNum, idx) => ({
      location: pageNum,
      text: upcomingTexts[idx + 1] || '',
      sourceUnits: sourceUnitsForPage(pageNum),
    }))
    .filter((item) => item.text.trim().length > 0);

  return {
    nextText,
    nextSourceUnits,
    additionalUpcoming,
  };
}
