import { expect, test } from '@playwright/test';
import { buildPdfOpKey } from '../../src/lib/server/compute/worker';

test.describe('compute worker pdf opKey', () => {
  test('keeps stable key when no force token is provided', () => {
    const base = {
      documentId: 'doc-123',
      namespace: 'ns-1',
      documentObjectKey: 'docs/ns-1/doc-123',
    };
    expect(buildPdfOpKey(base)).toBe('pdf_layout|v1|doc-123|ns-1|docs/ns-1/doc-123|');
    expect(buildPdfOpKey(base)).toBe(buildPdfOpKey(base));
  });

  test('cache-busts key when force token is provided', () => {
    const base = {
      documentId: 'doc-123',
      namespace: 'ns-1',
      documentObjectKey: 'docs/ns-1/doc-123',
    };
    const opKeyA = buildPdfOpKey({ ...base, forceToken: 'force-a' });
    const opKeyB = buildPdfOpKey({ ...base, forceToken: 'force-b' });
    const normal = buildPdfOpKey(base);

    expect(opKeyA).not.toBe(opKeyB);
    expect(opKeyA).not.toBe(normal);
    expect(opKeyB).not.toBe(normal);
  });
});
