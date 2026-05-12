import { expect, test } from '@playwright/test';

import {
  canonicalizeEpubSegmentAgainstSpineText,
  canonicalizeEpubSegmentsAgainstSpineText,
} from '../../src/lib/client/epub/canonicalize-epub-segment';
import { planCanonicalTtsSegments } from '../../src/lib/shared/tts-segment-plan';

test.describe('canonicalizeEpubSegmentAgainstSpineText', () => {
  test('maps an exact sentence to the canonical segment identity', () => {
    const spineText = [
      'First section sentence with enough words to stand alone.',
      'Second section sentence with enough words to stand alone.',
      'Third section sentence with enough words to stand alone.',
    ].join('\n');

    const result = canonicalizeEpubSegmentAgainstSpineText({
      segmentText: 'Second section sentence with enough words to stand alone.',
      spineText,
      spineHref: 'OEBPS/ch01.xhtml',
      spineIndex: 1,
      hintCharOffset: 70,
      keyPrefix: 'doc-1:epub:v1',
      maxBlockLength: 90,
    });

    expect(result).not.toBeNull();
    expect(result?.locator.readerType).toBe('epub');
    expect(result?.locator.spineHref).toBe('OEBPS/ch01.xhtml');
    expect(result?.locator.spineIndex).toBe(1);
    expect(result?.text).toContain('Second section sentence');
    expect(result?.segmentKey).toContain('doc-1:epub:v1:');
  });

  test('uses hintCharOffset to choose the nearest repeated exact match', () => {
    const repeated = 'Echo phrase repeated with enough words to stand alone.';
    const spineText = [
      repeated,
      'Middle bridge sentence that separates repeated text clearly.',
      repeated,
    ].join('\n');

    const plan = planCanonicalTtsSegments(
      [{ sourceKey: 'spine:2:OEBPS/ch02.xhtml', text: spineText }],
      { readerType: 'epub', maxBlockLength: 90, keyPrefix: 'doc-2:epub:v1' },
    );
    const matching = plan.segments.filter((segment) => segment.text === repeated);
    expect(matching.length).toBeGreaterThanOrEqual(2);
    const later = matching[matching.length - 1];

    const result = canonicalizeEpubSegmentAgainstSpineText({
      segmentText: repeated,
      spineText,
      spineHref: 'OEBPS/ch02.xhtml',
      spineIndex: 2,
      hintCharOffset: later.startAnchor.offset,
      keyPrefix: 'doc-2:epub:v1',
      maxBlockLength: 90,
    });

    expect(result).not.toBeNull();
    expect(result?.segmentKey).toBe(later.key);
    expect(result?.locator.charOffset).toBe(later.startAnchor.offset);
  });

  test('falls back to hint-window selection when text does not match exactly', () => {
    const spineText = [
      'Opening sentence that should map to block one.',
      'Middle sentence that should map to block two.',
      'Closing sentence that should map to block three.',
    ].join('\n');

    const plan = planCanonicalTtsSegments(
      [{ sourceKey: 'spine:3:OEBPS/ch03.xhtml', text: spineText }],
      { readerType: 'epub', maxBlockLength: 90, keyPrefix: 'doc-3:epub:v1' },
    );
    const target = plan.segments.find((segment) =>
      segment.text.includes('Middle sentence'),
    );
    expect(target).toBeTruthy();

    const result = canonicalizeEpubSegmentAgainstSpineText({
      segmentText: 'Non-matching walker boundary text fragment',
      spineText,
      spineHref: 'OEBPS/ch03.xhtml',
      spineIndex: 3,
      hintCharOffset: target!.startAnchor.offset,
      keyPrefix: 'doc-3:epub:v1',
      maxBlockLength: 90,
    });

    expect(result).not.toBeNull();
    expect(result?.segmentKey).toBe(target!.key);
    expect(result?.segmentIndex).toBe(target!.ordinal);
  });
});

test.describe('canonicalizeEpubSegmentsAgainstSpineText', () => {
  test('maps overlap-boundary drift sentences to forward canonical segments', () => {
    const sourceSentences = [
      'The star was particularly bright when the station lights switched off for cycle night.',
      'After losing his staring match, the night janitor muttered and walked on.',
      'You might have called it aqua, or perhaps a faded green under glass.',
      'A titch too purple for hot pink, it was still impossible to ignore.',
      'Needing no pole or wire to hold them aloft, the banners drifted above the plaza.',
      'He would have been confused to hear that this was considered a calm evening.',
    ];
    const spineText = sourceSentences.join('\n');
    const plan = planCanonicalTtsSegments(
      [{ sourceKey: 'spine:8:OEBPS/ch08.xhtml', text: spineText }],
      { readerType: 'epub', maxBlockLength: 80, keyPrefix: 'doc-8:epub:v1' },
    );
    expect(plan.segments.length).toBeGreaterThanOrEqual(6);

    const driftedLocalSentences = [
      plan.segments[0].text,
      plan.segments[1].text,
      plan.segments[2].text,
      plan.segments[3].text,
      // Mimics a resize boundary split that no longer matches canonical text.
      'Boundary drift fragment that does not exactly match any canonical segment.',
      plan.segments[5].text,
    ];
    const hints = [
      plan.segments[0].startAnchor.offset,
      plan.segments[1].startAnchor.offset,
      plan.segments[2].startAnchor.offset,
      plan.segments[3].startAnchor.offset,
      plan.segments[3].startAnchor.offset + 1,
      plan.segments[5].startAnchor.offset,
    ];

    const mapped = canonicalizeEpubSegmentsAgainstSpineText({
      segmentTexts: driftedLocalSentences,
      hintCharOffsets: hints,
      spineText,
      spineHref: 'OEBPS/ch08.xhtml',
      spineIndex: 8,
      keyPrefix: 'doc-8:epub:v1',
      maxBlockLength: 80,
    });

    expect(mapped[0]?.segmentKey).toBe(plan.segments[0].key);
    expect(mapped[1]?.segmentKey).toBe(plan.segments[1].key);
    expect(mapped[2]?.segmentKey).toBe(plan.segments[2].key);
    expect(mapped[3]?.segmentKey).toBe(plan.segments[3].key);
    // Core regression: despite hinting near segment 3, the mismatch sentence
    // maps to segment 4 (forward-only cursor), not backward to segment 3.
    expect(mapped[4]?.segmentIndex).toBe(4);
    expect(mapped[4]?.segmentKey).toBe(plan.segments[4].key);
    expect(mapped[5]?.segmentKey).toBe(plan.segments[5].key);
  });
});
