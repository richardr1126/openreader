import { describe, expect, test } from 'vitest';
import { shouldUseLegacyPdfBuild } from '../../src/lib/client/pdf';

describe('PDF.js Safari build selection', () => {
  test('uses the legacy build through Safari 18', () => {
    expect(shouldUseLegacyPdfBuild(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15',
    )).toBe(true);
  });

  test('uses the standard build starting with Safari 19', () => {
    expect(shouldUseLegacyPdfBuild(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/19.0 Safari/605.1.15',
    )).toBe(false);
  });

  test('does not treat Chromium user agents as Safari', () => {
    expect(shouldUseLegacyPdfBuild(
      'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    )).toBe(false);
  });

  test('keeps the safe fallback for Safari without a version token', () => {
    expect(shouldUseLegacyPdfBuild('Mozilla/5.0 Safari/605.1.15')).toBe(true);
  });
});
