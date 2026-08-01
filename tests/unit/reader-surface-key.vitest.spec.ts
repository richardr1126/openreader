import { describe, expect, test } from 'vitest';

import { readerSurfaceKey } from '@/lib/client/reader-readiness/surface-key';
import type { ReaderPayload } from '@/types/reader-bootstrap';

function htmlPayload(contentVersion: string, planId: string, planSignature: string): ReaderPayload {
  return {
    documentId: 'doc-html',
    readerType: 'html',
    document: {
      id: 'doc-html',
      name: 'fixture.txt',
      type: 'html',
      size: 4,
      lastModified: 1,
      contentVersion,
    },
    settings: { schemaVersion: 1, language: 'en' },
    plan: {
      planId,
      planObjectKey: `plans/${planId}.json`,
      planSignature,
      sessionId: '',
      documentId: 'doc-html',
      readerType: 'html',
      plannedCount: 0,
      segments: [],
    },
    initialPosition: null,
  };
}

describe('reader surface identity', () => {
  test('is stable across object recreation and changes for content or plan identity', () => {
    const initial = htmlPayload('content-v1', 'plan-v1', 'signature-v1');
    expect(readerSurfaceKey({ ...initial })).toBe(readerSurfaceKey(initial));
    expect(readerSurfaceKey(htmlPayload('content-v2', 'plan-v1', 'signature-v1')))
      .not.toBe(readerSurfaceKey(initial));
    expect(readerSurfaceKey(htmlPayload('content-v1', 'plan-v2', 'signature-v2')))
      .not.toBe(readerSurfaceKey(initial));
  });
});
