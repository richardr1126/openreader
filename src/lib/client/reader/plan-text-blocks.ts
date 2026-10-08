import type { HtmlBlock } from '@openreader/tts/html-blocks';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import { segmentSourceKey } from '@/lib/client/reader/segment-hit';

/**
 * Text-reader blocks for the plain-text reading mode of PDF and EPUB, built
 * from the playback plan. Each block's anchor id is the key
 * {@link segmentSourceKey} gives its segments, so the text reader's sentence
 * highlight, word highlight, tap-to-seek and auto-scroll resolve them exactly
 * as they resolve a Markdown or TXT block.
 *
 * - PDF: one paragraph per parsed layout block (segments sharing page+block).
 * - EPUB: the client plan carries no paragraph boundaries (the worker chunks
 *   chapter text into bounded segments), so every segment is its own
 *   paragraph.
 */
export function buildPlanTextBlocks(
  segments: readonly Pick<CanonicalTtsSegment, 'ordinal' | 'text' | 'ownerLocator'>[],
): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];
  const byKey = new Map<string, HtmlBlock>();
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const key = segmentSourceKey(segment);
    const existing = byKey.get(key);
    if (existing) {
      existing.raw = `${existing.raw} ${text}`;
      existing.plainText = existing.raw;
      continue;
    }
    const block: HtmlBlock = {
      index: blocks.length,
      anchorId: key,
      kind: 'paragraph',
      raw: text,
      plainText: text,
    };
    byKey.set(key, block);
    blocks.push(block);
  }
  return blocks;
}
