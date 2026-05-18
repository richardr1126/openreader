import type { ParsedPdfDocument, ParsedPdfBlock } from '@/types/parsed-pdf';

const STITCHABLE_KINDS = new Set<ParsedPdfBlock['kind']>([
  'text',
  'content',
  'reference_content',
  'aside_text',
  'abstract',
  'algorithm',
  'reference',
]);

function stripTrailingClosers(text: string): string {
  return text.trim().replace(/[\"'”’\]\)]+$/g, '');
}

function isSentenceTerminal(text: string): boolean {
  return /[.!?]$/.test(stripTrailingClosers(text));
}

function canStitch(a: ParsedPdfBlock, b: ParsedPdfBlock): boolean {
  if (!STITCHABLE_KINDS.has(a.kind)) return false;
  if (a.kind !== b.kind) return false;
  if (isSentenceTerminal(a.text)) return false;
  const next = b.text.trim();
  if (!next) return false;
  if (/^[A-Z]/.test(next)) return false;
  return true;
}

const HARD_BOUNDARY_KINDS = new Set<ParsedPdfBlock['kind']>([
  'paragraph_title',
  'doc_title',
]);

function findTailCandidateIndex(blocks: ParsedPdfBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block || !block.text.trim()) continue;
    if (STITCHABLE_KINDS.has(block.kind)) return i;
  }
  return -1;
}

function findHeadCandidateIndex(blocks: ParsedPdfBlock[]): number {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block || !block.text.trim()) continue;
    if (STITCHABLE_KINDS.has(block.kind)) return i;
  }
  return -1;
}

function hasHardBoundaryBetween(
  pageBlocks: ParsedPdfBlock[],
  startInclusive: number,
  endExclusive: number,
): boolean {
  for (let i = startInclusive; i < endExclusive; i += 1) {
    const block = pageBlocks[i];
    if (block && HARD_BOUNDARY_KINDS.has(block.kind)) return true;
  }
  return false;
}

export function stitchCrossPageBlocks(doc: ParsedPdfDocument): ParsedPdfDocument {
  const pages = doc.pages.map((page) => ({ ...page, blocks: page.blocks.map((b) => ({ ...b, fragments: b.fragments.map((f) => ({ ...f })) })) }));

  for (let i = 0; i < pages.length - 1; i += 1) {
    const page = pages[i];
    const next = pages[i + 1];
    const tailIndex = findTailCandidateIndex(page.blocks);
    const headIndex = findHeadCandidateIndex(next.blocks);
    if (tailIndex < 0 || headIndex < 0) continue;

    if (hasHardBoundaryBetween(page.blocks, tailIndex + 1, page.blocks.length)) continue;
    if (hasHardBoundaryBetween(next.blocks, 0, headIndex)) continue;

    const tail = page.blocks[tailIndex];
    const head = next.blocks[headIndex];
    if (!tail || !head) continue;
    if (!canStitch(tail, head)) continue;

    tail.fragments.push(...head.fragments);
    tail.text = `${tail.text} ${head.text}`.replace(/\s+/g, ' ').trim();
    next.blocks.splice(headIndex, 1);
  }

  return {
    ...doc,
    pages,
  };
}
