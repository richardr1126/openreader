import { describe, expect, test } from 'vitest';

import { mergeDocumentSettings } from '../../src/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '../../src/types/document-settings';

describe('document settings language', () => {
  test('defaults to automatic language resolution', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, null).language).toBe('auto');
  });

  test('normalizes explicit BCP 47 language tags', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'zh-cn' }).language).toBe('zh-CN');
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'JA' }).language).toBe('ja');
  });

  test('preserves language when PDF settings are absent', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'fr' })).toMatchObject({
      language: 'fr',
      pdf: DEFAULT_DOCUMENT_SETTINGS.pdf,
    });
  });
});
