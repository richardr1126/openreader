import { describe, expect, test } from 'vitest';
import {
  assertAuthoritativePlaybackPlan,
  normalizePlaybackPlan,
} from '../../src/lib/client/tts/playback-plan';

describe('authoritative playback plan artifacts', () => {
  test('accepts a valid zero-segment artifact as authoritative', () => {
    const plan = normalizePlaybackPlan({
      planId: 'plan-1',
      planObjectKey: 'plans/plan-1.json',
      planSignature: 'abcdef12',
      documentId: 'doc-1',
      readerType: 'html',
      plannedCount: 0,
      segments: [],
    });
    expect(assertAuthoritativePlaybackPlan(plan, { documentId: 'doc-1', readerType: 'html' }).segments).toEqual([]);
  });

  test('rejects mismatched and partially normalized artifacts', () => {
    const plan = normalizePlaybackPlan({
      planId: 'plan-1',
      planObjectKey: 'plans/plan-1.json',
      planSignature: 'abcdef12',
      documentId: 'other-doc',
      readerType: 'pdf',
      plannedCount: 1,
      segments: [{ ordinal: 0, text: '' }],
    });
    expect(() => assertAuthoritativePlaybackPlan(plan, { documentId: 'doc-1', readerType: 'pdf' })).toThrow();
  });
});
