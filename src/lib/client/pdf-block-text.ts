import type { ParsedPdfBlockKind, ParsedPdfPage } from '@/types/parsed-pdf';

export function buildPageTextFromBlocks(
  page: ParsedPdfPage,
  skipKinds: ParsedPdfBlockKind[] = [],
): string {
  const skip = new Set(skipKinds);
  return page.blocks
    .filter((block) => !skip.has(block.kind))
    .sort((a, b) => {
      const aOrder = a.fragments[0]?.readingOrder ?? 0;
      const bOrder = b.fragments[0]?.readingOrder ?? 0;
      return aOrder - bOrder;
    })
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
