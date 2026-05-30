import { describe, expect, test } from 'vitest';

import { buildSegmentKey, buildSegmentKeyPrefix, planCanonicalTtsSegments } from '../../src/lib/shared/tts-segment-plan';

describe('planCanonicalTtsSegments', () => {
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

  test('keeps paragraph-title boundaries when source boundaries are enforced', () => {
    const plan = planCanonicalTtsSegments([
      {
        sourceKey: 'abstract',
        locator: { page: 1, readerType: 'pdf', blockId: 'a1' },
        text: 'Released under the permissive MIT license, OpenHands is a community project spanning academia and industry with more than 2.1K contributions.',
      },
      {
        sourceKey: 'intro-title',
        locator: { page: 1, readerType: 'pdf', blockId: 't1' },
        text: '1 INTRODUCTION',
      },
      {
        sourceKey: 'intro-body',
        locator: { page: 1, readerType: 'pdf', blockId: 'p1' },
        text: 'Powered by large language models (LLMs; OpenAI 2024b; Team et al. 2023), user-facing AI systems have become increasingly capable of performing complex tasks such as accurately responding to user queries, solving math problems, and generating code.',
      },
    ], {
      readerType: 'pdf',
      maxBlockLength: 450,
      keyPrefix: 'doc:v1',
      enforceSourceBoundaries: true,
    });

    expect(plan.segments.some((segment) => segment.ownerSourceKey === 'intro-title' && segment.text === '1 INTRODUCTION')).toBeTruthy();
    expect(plan.segments.some((segment) => segment.ownerSourceKey === 'intro-body' && segment.text.startsWith('Powered by large language models'))).toBeTruthy();
    expect(plan.segments.some((segment) => segment.text.startsWith('1 INTRODUCTION Powered by'))).toBeFalsy();
  });

  test('does not drop first sentence when canonical rematch fails in enforced boundary mode', () => {
    const plan = planCanonicalTtsSegments([
      {
        sourceKey: 'title',
        locator: { page: 1, readerType: 'pdf', blockId: 't1' },
        text: '1 INTRODUCTION',
      },
      {
        sourceKey: 'intro',
        locator: { page: 1, readerType: 'pdf', blockId: 'p1' },
        // Missing whitespace after sentence terminal is a common PDF extraction artifact.
        text: 'Powered by large language models have become increasingly capable of generating code.In particular, AI agents have recently received ever-increasing research focus.',
      },
    ], {
      readerType: 'pdf',
      maxBlockLength: 450,
      keyPrefix: 'doc:v1',
      enforceSourceBoundaries: true,
    });

    const introSegments = plan.segments
      .filter((segment) => segment.ownerSourceKey === 'intro')
      .map((segment) => segment.text);
    const combinedIntro = introSegments.join(' ');
    expect(combinedIntro.includes('Powered by large language models')).toBeTruthy();
    expect(combinedIntro.includes('In particular, AI agents')).toBeTruthy();
  });
});

describe('buildSegmentKeyPrefix / buildSegmentKey contract', () => {
  // These keys are the bridge between persistence and the sidebar's merge of
  // synth rows with manifest rows. Both sides must produce identical keys for
  // the same `(documentId, readerType, text)` triple, or the sidebar will
  // show duplicates.

  test('prefix shape is `${documentId}:${readerType}:v1` (or "document" when documentId is falsy)', () => {
    expect(buildSegmentKeyPrefix('abc123', 'epub')).toBe('abc123:epub:v1');
    expect(buildSegmentKeyPrefix(null, 'pdf')).toBe('document:pdf:v1');
    expect(buildSegmentKeyPrefix('', 'epub')).toBe('document:epub:v1');
  });

  test('same prefix + same text → same key (sidebar can match synth to manifest)', () => {
    const prefix = buildSegmentKeyPrefix('doc-1', 'epub');
    const k1 = buildSegmentKey(prefix, 'Hello world.');
    const k2 = buildSegmentKey(prefix, 'Hello world.');
    expect(k1).toBe(k2);
  });

  test('normalization makes whitespace + casing differences identity-equivalent', () => {
    const prefix = buildSegmentKeyPrefix('doc-1', 'epub');
    const a = buildSegmentKey(prefix, '  Hello   world.  ');
    const b = buildSegmentKey(prefix, 'hello world.');
    expect(a).toBe(b);
  });

  test('different readerType yields different keys for the same text', () => {
    const a = buildSegmentKey(buildSegmentKeyPrefix('doc-1', 'epub'), 'Same text.');
    const b = buildSegmentKey(buildSegmentKeyPrefix('doc-1', 'pdf'), 'Same text.');
    expect(a).not.toBe(b);
  });
});
