import { describe, expect, test } from 'vitest';

import { planCanonicalTtsSegments } from '../../src/lib/shared/tts-segment-plan';

describe('planCanonicalTtsSegments – leading context handling', () => {
  test('clean boundary: splits block so current source keeps its first sentence', () => {
    const currentSourceKey = 'str:epubcfi(/6/10!/4/2)';
    const plan = planCanonicalTtsSegments([
      {
        sourceKey: `previous:${currentSourceKey}`,
        text: 'This is the last sentence from the previous page. It ends cleanly here.',
        locator: null,
      },
      {
        sourceKey: currentSourceKey,
        text: 'The first sentence on this page starts fresh. And here is the second sentence.',
        locator: { location: 'epubcfi(/6/10!/4/2)', readerType: 'epub' as const },
      },
    ], {
      readerType: 'epub',
      maxBlockLength: 450,
      keyPrefix: 'doc:epub:v1',
    });

    const currentSegments = plan.segments.filter(seg => seg.ownerSourceKey === currentSourceKey);
    expect(currentSegments.length).toBe(1);
    expect(currentSegments[0].text).toContain('The first sentence on this page');
    expect(currentSegments[0].startAnchor.sourceKey).toBe(currentSourceKey);
    expect(currentSegments[0].startAnchor.offset).toBe(0);
    expect(currentSegments[0].spansSourceBoundary).toBe(false);
  });

  test('overlapping sentence: stays owned by context source, filtered out of current page', () => {
    const currentSourceKey = 'str:epubcfi(/6/10!/4/2)';
    const previousSourceKey = `previous:${currentSourceKey}`;
    const plan = planCanonicalTtsSegments([
      {
        sourceKey: previousSourceKey,
        text: 'The sentence starts on the previous page and',
        locator: null,
      },
      {
        sourceKey: currentSourceKey,
        text: 'finishes on the current page with enough context. Next sentence here.',
        locator: { location: 'epubcfi(/6/10!/4/2)', readerType: 'epub' as const },
      },
    ], {
      readerType: 'epub',
      maxBlockLength: 450,
      keyPrefix: 'doc:epub:v1',
    });

    // The overlapping sentence should stay owned by the context source.
    const contextSegments = plan.segments.filter(seg => seg.ownerSourceKey === previousSourceKey);
    expect(contextSegments.length).toBeGreaterThanOrEqual(1);
    expect(contextSegments[0].text).toContain('The sentence starts on the previous page and finishes on the current page');
    expect(contextSegments[0].spansSourceBoundary).toBe(true);

    // Current page segments should NOT include the overlapping sentence.
    const currentSegments = plan.segments.filter(seg => seg.ownerSourceKey === currentSourceKey);
    for (const seg of currentSegments) {
      expect(seg.text).not.toContain('previous page');
    }
  });

  test('clean boundary with longer text: preserves first sentence', () => {
    const currentSourceKey = 'str:epubcfi(/6/10!/4/2)';
    const longPreviousText = 'This is a much longer paragraph from the previous page. It contains several sentences that fill up more space. ' +
      'The story continues with more details about what happened. Characters move through the scene with purpose. ' +
      'Each step brings them closer to their destination. The sun sets slowly behind the mountains. ' +
      'Wind rustles through the leaves of the ancient trees. Birds call out their evening songs.';

    const currentText = 'The next morning dawned bright and clear. She stepped outside and breathed in the fresh air. ' +
      'The garden was blooming with colorful flowers. Bees buzzed lazily from blossom to blossom. ' +
      'It was the kind of day that made everything seem possible. She smiled to herself and walked down the path.';

    const plan = planCanonicalTtsSegments([
      {
        sourceKey: `previous:${currentSourceKey}`,
        text: longPreviousText,
        locator: null,
      },
      {
        sourceKey: currentSourceKey,
        text: currentText,
        locator: { location: 'epubcfi(/6/10!/4/2)', readerType: 'epub' as const },
      },
    ], {
      readerType: 'epub',
      maxBlockLength: 450,
      keyPrefix: 'doc:epub:v1',
    });

    const currentSegments = plan.segments.filter(seg => seg.ownerSourceKey === currentSourceKey);
    const reconstructed = currentSegments.map(s => s.text).join(' ');
    expect(reconstructed).toContain('The next morning dawned bright and clear');
    expect(reconstructed).toContain('She stepped outside');
    expect(reconstructed).toContain('She smiled to herself');
  });

  test('forward-looking boundary between real sources is preserved', () => {
    const plan = planCanonicalTtsSegments([
      {
        sourceKey: 'page:1',
        locator: { page: 1, readerType: 'pdf' as const },
        text: 'The boundary sentence begins on page one and',
      },
      {
        sourceKey: 'page:2',
        locator: { page: 2, readerType: 'pdf' as const },
        text: 'finishes on page two with enough words to stand alone. A short follow up.',
      },
    ], {
      readerType: 'pdf',
      maxBlockLength: 60,
      keyPrefix: 'doc:v1',
    });

    // Forward boundary between two real sources stays unified.
    expect(plan.segments[0]).toMatchObject({
      ownerSourceKey: 'page:1',
      spansSourceBoundary: true,
    });
    expect(plan.segments[0].text).toContain('begins on page one and finishes on page two');
  });

  test('overlapping sentence with comma: stays owned by context source', () => {
    const currentSourceKey = 'str:epubcfi(/6/14!/4/2)';
    const previousSourceKey = `previous:${currentSourceKey}`;
    const plan = planCanonicalTtsSegments([
      {
        sourceKey: previousSourceKey,
        text: 'She walked down the lane, past the old church,',
        locator: null,
      },
      {
        sourceKey: currentSourceKey,
        text: 'and turned left at the river. The bridge was old.',
        locator: { location: 'epubcfi(/6/14!/4/2)', readerType: 'epub' as const },
      },
    ], {
      readerType: 'epub',
      maxBlockLength: 450,
      keyPrefix: 'doc:epub:v1',
    });

    // Comma is not sentence-ending punctuation → overlapping → owned by context.
    const contextSegments = plan.segments.filter(seg => seg.ownerSourceKey === previousSourceKey);
    expect(contextSegments.length).toBeGreaterThanOrEqual(1);
    expect(contextSegments[0].text).toContain('She walked down the lane');
    expect(contextSegments[0].text).toContain('and turned left at the river');

    // Current page should NOT include the overlapping sentence.
    const currentSegments = plan.segments.filter(seg => seg.ownerSourceKey === currentSourceKey);
    for (const seg of currentSegments) {
      expect(seg.text).not.toContain('She walked down the lane');
    }
  });

  test('clean boundary with quoted speech ending in period', () => {
    const currentSourceKey = 'str:epubcfi(/6/16!/4/2)';
    const plan = planCanonicalTtsSegments([
      {
        sourceKey: `previous:${currentSourceKey}`,
        text: '"I will be back tomorrow," she said.',
        locator: null,
      },
      {
        sourceKey: currentSourceKey,
        text: 'The door closed behind her. Silence filled the room.',
        locator: { location: 'epubcfi(/6/16!/4/2)', readerType: 'epub' as const },
      },
    ], {
      readerType: 'epub',
      maxBlockLength: 450,
      keyPrefix: 'doc:epub:v1',
    });

    const currentSegments = plan.segments.filter(seg => seg.ownerSourceKey === currentSourceKey);
    expect(currentSegments.length).toBe(1);
    // Clean boundary after quoted speech → split correctly.
    expect(currentSegments[0].text).toContain('The door closed behind her');
    expect(currentSegments[0].text).not.toContain('I will be back');
  });
});
