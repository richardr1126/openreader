import type { CanonicalTtsSourceUnit } from './segment-plan';
import type { TTSSegmentLocator } from './types';

/**
 * Minimal structural views of the parsed-PDF layout artifact. Declared locally
 * so this package stays decoupled from the worker/app parsed-PDF types — both
 * the worker's `ParsedPdfPage` and the app's are structurally assignable here.
 * This module is the single source of truth for turning parsed layout into TTS
 * source units, shared by the client preview path and the worker-owned planner
 * so both mint identical `sourceKey`s and locators (and therefore identical
 * segment keys / cached audio).
 */
export interface ParsedPdfBlockFragmentLike {
  readingOrder?: number;
}

export interface ParsedPdfBlockLike {
  id: string;
  kind: string;
  text: string;
  fragments: ParsedPdfBlockFragmentLike[];
}

export interface ParsedPdfPageLike {
  blocks: ParsedPdfBlockLike[];
}

/**
 * Build the ordered TTS source units for a single parsed PDF page. Each block
 * becomes one source unit keyed `pdf:<page>:<blockId>` with a page+block
 * locator. Blocks whose kind is in `skipKinds` (admin/document setting) are
 * dropped, as are empty blocks.
 */
export function buildPdfPageSourceUnits(
  page: ParsedPdfPageLike | undefined,
  pageNum: number,
  skipKinds: readonly string[] = [],
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

/**
 * Flatten a parsed PDF page into a single reading-order plain-text string,
 * skipping `skipKinds` and collapsing whitespace. Used for previews and as the
 * coarse page text fed to the segmenter.
 */
export function buildPageTextFromBlocks(
  page: ParsedPdfPageLike,
  skipKinds: readonly string[] = [],
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
