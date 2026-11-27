import { createHash } from 'node:crypto';
import type { ParsedPdfDocument } from '../operations/contracts';

type NarrationLayout = Pick<ParsedPdfDocument, 'pages' | 'narrationRevision'>;

/** Hash of what a PDF narration plan reads from a layout: page order and each block's id, kind and text. */
function narrationInputsHash(layout: Pick<ParsedPdfDocument, 'pages'>): string {
  const pages = [...layout.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  return createHash('sha256')
    .update(JSON.stringify(pages.map((page) => [
      page.pageNumber,
      page.blocks.map((block) => [block.id, block.kind, block.text]),
    ])))
    .digest('hex')
    .slice(0, 32);
}

/**
 * The narration revision for a layout that replaces `previous`. Plans and
 * segment audio are keyed by the revision, so a replacement that narrates the
 * same blocks keeps the previous value (or its absence) and reuses them. A
 * replacement that changes them gets a revision of its own. A first layout has
 * no revision, and an unreadable previous layout counts as changed.
 */
export function resolvePdfNarrationRevision(
  next: Pick<ParsedPdfDocument, 'pages'>,
  previous: NarrationLayout | 'unreadable' | null,
): string | undefined {
  if (previous === null) return undefined;
  const nextHash = narrationInputsHash(next);
  if (previous !== 'unreadable' && previousInputsHash(previous) === nextHash) {
    return previous.narrationRevision;
  }
  return nextHash;
}

function previousInputsHash(previous: NarrationLayout): string | null {
  try {
    return narrationInputsHash(previous);
  } catch {
    return null;
  }
}

export function parsePreviousPdfLayout(bytes: ArrayBuffer): NarrationLayout | 'unreadable' {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<NarrationLayout> | null;
    if (!parsed || !Array.isArray(parsed.pages)) return 'unreadable';
    return {
      pages: parsed.pages,
      ...(typeof parsed.narrationRevision === 'string' ? { narrationRevision: parsed.narrationRevision } : {}),
    };
  } catch {
    return 'unreadable';
  }
}
