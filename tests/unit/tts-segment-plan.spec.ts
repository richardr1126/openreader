import { expect, test } from '@playwright/test';

import { planCanonicalTtsSegments } from '../../src/lib/shared/tts-segment-plan';

test.describe('planCanonicalTtsSegments', () => {
  test('emits a cross-boundary segment once and assigns it to the source where it starts', () => {
    const plan = planCanonicalTtsSegments([
      {
        sourceKey: 'page:1',
        locator: { page: 1, readerType: 'pdf' },
        text: 'The boundary sentence begins on page one and',
      },
      {
        sourceKey: 'page:2',
        locator: { page: 2, readerType: 'pdf' },
        text: 'finishes on page two with enough words to stand alone. A short follow up.',
      },
    ], {
      readerType: 'pdf',
      maxBlockLength: 60,
      keyPrefix: 'doc:v1',
    });

    expect(plan.segments.length).toBeGreaterThanOrEqual(2);
    expect(plan.segments[0]).toMatchObject({
      ownerSourceKey: 'page:1',
      ownerLocator: { page: 1, readerType: 'pdf' },
      spansSourceBoundary: true,
    });
    expect(plan.segments[0].text).toContain('begins on page one and finishes on page two');
    expect(plan.segments[1]).toMatchObject({
      ownerSourceKey: 'page:2',
      spansSourceBoundary: false,
    });
    expect(plan.segments[1].text).toContain('A short follow up.');
  });

  test('returns the same segment keys for the same canonical source anchors', () => {
    const options = {
      readerType: 'epub' as const,
      maxBlockLength: 70,
      keyPrefix: 'book:v1',
    };

    const firstPlan = planCanonicalTtsSegments([
      {
        sourceKey: 'chapter:1',
        text: 'First sentence with enough words to be its own block. Second sentence with enough words to be its own block.',
      },
    ], options);

    const secondPlan = planCanonicalTtsSegments([
      {
        sourceKey: 'chapter:1',
        text: 'First sentence with enough words to be its own block. Second sentence with enough words to be its own block.',
      },
    ], options);

    expect(secondPlan.segments.map((segment) => segment.text)).toEqual(
      firstPlan.segments.map((segment) => segment.text),
    );
    expect(secondPlan.segments.map((segment) => segment.key)).toEqual(
      firstPlan.segments.map((segment) => segment.key),
    );
  });

  test('repeated identical text produces the same content-addressed key', () => {
    const repeated = 'Repeat this exact sentence with enough filler words here.';
    const plan = planCanonicalTtsSegments([
      { sourceKey: 'chapter:1', text: `${repeated} ${repeated}` },
    ], {
      readerType: 'epub',
      maxBlockLength: 50,
      keyPrefix: 'book:v1',
    });

    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].text).toBe(repeated);
    expect(plan.segments[1].text).toBe(repeated);
    // Content-addressed keys: same text → same key (viewport-independent).
    // Segments remain distinct via ordinal and anchors for client-side use.
    expect(plan.segments[0].key).toBe(plan.segments[1].key);
    expect(plan.segments[0].ordinal).not.toBe(plan.segments[1].ordinal);
  });

  test('does not let locator changes alter canonical keys', () => {
    const text = 'Locator changes should not alter this stable segment identity.';
    const a = planCanonicalTtsSegments([
      { sourceKey: 'page:1', locator: { page: 1, readerType: 'pdf' }, text },
    ], {
      readerType: 'pdf',
      keyPrefix: 'doc:v1',
    });
    const b = planCanonicalTtsSegments([
      { sourceKey: 'page:1', locator: { page: 99, readerType: 'pdf' }, text },
    ], {
      readerType: 'pdf',
      keyPrefix: 'doc:v1',
    });

    expect(a.segments.map((segment) => segment.key)).toEqual(
      b.segments.map((segment) => segment.key),
    );
    expect(a.segments[0].ownerLocator).toEqual({ page: 1, readerType: 'pdf' });
    expect(b.segments[0].ownerLocator).toEqual({ page: 99, readerType: 'pdf' });
  });

  test('generates identical segment keys for the same text from different viewports (sourceKeys)', () => {
    const sentence = 'This sentence is rendered on different viewports.';
    
    // Viewport A (e.g. narrow device)
    const planA = planCanonicalTtsSegments([
      { sourceKey: 'epubcfi(/6/10!/4/2)', text: sentence },
    ], {
      readerType: 'epub',
      keyPrefix: 'book:v1',
    });

    // Viewport B (e.g. wide device)
    const planB = planCanonicalTtsSegments([
      { sourceKey: 'epubcfi(/6/12!/4/4)', text: sentence },
    ], {
      readerType: 'epub',
      keyPrefix: 'book:v1',
    });

    // Content-addressed keys should match perfectly because the text is the same
    expect(planA.segments[0].key).toBe(planB.segments[0].key);
    
    // But the client-side anchoring accurately reflects the different viewport source
    expect(planA.segments[0].ownerSourceKey).toBe('epubcfi(/6/10!/4/2)');
    expect(planB.segments[0].ownerSourceKey).toBe('epubcfi(/6/12!/4/4)');
    expect(planA.segments[0].startAnchor.sourceKey).not.toBe(planB.segments[0].startAnchor.sourceKey);
  });

  test('anchors segment offsets back to normalized source text', () => {
    const plan = planCanonicalTtsSegments([
      { sourceKey: 'page:1', text: 'First sentence.  ' },
      { sourceKey: 'page:2', text: '  Second sentence with enough words to be separate.' },
    ], {
      readerType: 'epub',
      maxBlockLength: 50,
      keyPrefix: 'book:v1',
    });

    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].startAnchor).toEqual({ sourceKey: 'page:1', offset: 0 });
    expect(plan.segments[0].endAnchor.sourceKey).toBe('page:1');
    expect(plan.segments[1].startAnchor).toEqual({ sourceKey: 'page:2', offset: 0 });
    expect(plan.text).toBe('First sentence. Second sentence with enough words to be separate.');
  });

  test('ignores empty source units', () => {
    const plan = planCanonicalTtsSegments([
      { sourceKey: 'empty:1', text: '   ' },
      { sourceKey: 'page:1', text: 'Only useful text remains.' },
      { sourceKey: 'empty:2', text: '\n\n' },
    ], {
      readerType: 'pdf',
      keyPrefix: 'doc:v1',
    });

    expect(plan.text).toBe('Only useful text remains.');
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].ownerSourceKey).toBe('page:1');
  });
});
