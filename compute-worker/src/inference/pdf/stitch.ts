import type { ParsedPdfDocument, ParsedPdfBlock } from '../types/parsed-pdf';

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

function splitHeadContinuation(text: string): { continuation: string; remainder: string } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return { continuation: '', remainder: '' };

  const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}']);
  const isTerminal = (ch: string): boolean => ch === '.' || ch === '!' || ch === '?';

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (!isTerminal(ch)) continue;

    const prev = i > 0 ? normalized[i - 1] : '';
    const next = i + 1 < normalized.length ? normalized[i + 1] : '';
    if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue;

    let cut = i + 1;
    while (cut < normalized.length && CLOSERS.has(normalized[cut])) cut += 1;

    const after = cut < normalized.length ? normalized[cut] : '';
    if (!after || /\s/.test(after) || /[A-Z]/.test(after)) {
      return {
        continuation: normalized.slice(0, cut).trim(),
        remainder: normalized.slice(cut).trim(),
      };
    }
  }

  return {
    continuation: normalized,
    remainder: '',
  };
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

    const { continuation, remainder } = splitHeadContinuation(head.text);
    if (!continuation) continue;

    const continuationFragment = head.fragments[0]
      ? { ...head.fragments[0], text: continuation }
      : null;

    if (continuationFragment) {
      tail.fragments.push(continuationFragment);
    }
    tail.text = `${tail.text} ${continuation}`.replace(/\s+/g, ' ').trim();

    if (!remainder) {
      next.blocks.splice(headIndex, 1);
      continue;
    }

    head.text = remainder;
    if (head.fragments[0]) {
      head.fragments[0].text = remainder;
    }
  }

  return {
    ...doc,
    pages,
  };
}
