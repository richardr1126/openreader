import { describe, expect, it } from 'vitest';

import { buildPlanTextBlocks } from '@/lib/client/reader/plan-text-blocks';
import { indexSegmentsBySource, segmentSourceKey } from '@/lib/client/reader/segment-hit';
import { normalizePlaybackPlan, playbackPlanToCanonicalSegments } from '@/lib/shared/playback-plan';

const pdfSegments = playbackPlanToCanonicalSegments(normalizePlaybackPlan({
  segments: [
    { ordinal: 0, segmentKey: 'k0', text: 'Chapter One', locator: { readerType: 'pdf', page: 1, blockId: 'b0' } },
    { ordinal: 1, segmentKey: 'k1', text: 'It was a *bright* day.', locator: { readerType: 'pdf', page: 1, blockId: 'b1' } },
    { ordinal: 2, segmentKey: 'k2', text: 'The end.', locator: { readerType: 'pdf', page: 1, blockId: 'b1' } },
    { ordinal: 3, segmentKey: 'k3', text: 'The end.', locator: { readerType: 'pdf', page: 2, blockId: 'b0' } },
  ],
}));

const epubSegments = playbackPlanToCanonicalSegments(normalizePlaybackPlan({
  segments: [
    { ordinal: 0, segmentKey: 'e0', text: '# Not a heading. Dorothy lived.', locator: { readerType: 'epub', spineHref: 'c1.xhtml', spineIndex: 1, charOffset: 0 } },
    { ordinal: 1, segmentKey: 'e1', text: 'Toto barked.', locator: { readerType: 'epub', spineHref: 'c1.xhtml', spineIndex: 1, charOffset: 32 } },
  ],
}));

describe('buildPlanTextBlocks', () => {
  it('groups PDF sentences by page and parsed block, keyed as the tap index keys them', () => {
    const blocks = buildPlanTextBlocks(pdfSegments);
    expect(blocks.map((block) => [block.anchorId, block.plainText])).toEqual([
      ['pdf:1:b0', 'Chapter One'],
      ['pdf:1:b1', 'It was a *bright* day. The end.'],
      ['pdf:2:b0', 'The end.'],
    ]);
    const index = indexSegmentsBySource(pdfSegments);
    expect(blocks.map((block) => index.get(block.anchorId)?.map((candidate) => candidate.ordinal))).toEqual([
      [0], [1, 2], [3],
    ]);
  });

  it('gives every EPUB segment its own literal paragraph', () => {
    const blocks = buildPlanTextBlocks(epubSegments);
    expect(blocks.map((block) => [block.anchorId, block.kind, block.raw])).toEqual([
      ['segment:0', 'paragraph', '# Not a heading. Dorothy lived.'],
      ['segment:1', 'paragraph', 'Toto barked.'],
    ]);
    expect(blocks.map((block) => block.anchorId)).toEqual(epubSegments.map(segmentSourceKey));
  });

  it('scopes every sentence highlight to a block that contains its text verbatim', () => {
    // The viewer highlights inside the block whose id is segmentSourceKey(segment),
    // so a repeated sentence ("The end.") resolves to its own page's block.
    for (const segments of [pdfSegments, epubSegments]) {
      const blocksById = new Map(buildPlanTextBlocks(segments).map((block) => [block.anchorId, block]));
      for (const segment of segments) {
        const owner = blocksById.get(segmentSourceKey(segment));
        expect(owner?.plainText).toContain(segment.text);
      }
    }
    expect(segmentSourceKey(pdfSegments[2])).not.toBe(segmentSourceKey(pdfSegments[3]));
  });
});
