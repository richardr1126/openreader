import { describe, expect, test } from 'vitest';
import {
  FORCE_REPARSE_CONFIRM_MESSAGE,
  FORCE_REPARSE_CONFIRM_TEXT,
  FORCE_REPARSE_CONFIRM_TITLE,
  isForceReparseDisabled,
} from '../../src/lib/client/pdf/force-reparse';
import { shouldPreferCurrentPdfParseOperation } from '../../src/lib/server/pdf-parse/readiness';
import type { PdfLayoutResolution } from '../../src/lib/server/compute-worker/protocol';

describe('pdf force reparse controls', () => {
  test('disables action while parse is pending or running', () => {
    expect(isForceReparseDisabled('pending')).toBeTruthy();
    expect(isForceReparseDisabled('running')).toBeTruthy();
    expect(isForceReparseDisabled('ready')).toBeFalsy();
    expect(isForceReparseDisabled('failed')).toBeFalsy();
    expect(isForceReparseDisabled(null)).toBeFalsy();
  });

  test('confirmation copy warns about expensive rerun', () => {
    expect(FORCE_REPARSE_CONFIRM_TITLE).toContain('Reparse');
    expect(FORCE_REPARSE_CONFIRM_TEXT).toContain('Reparse');
    expect(FORCE_REPARSE_CONFIRM_MESSAGE.toLowerCase()).toContain('from scratch');
    expect(FORCE_REPARSE_CONFIRM_MESSAGE.toLowerCase()).toContain('take a while');
  });

  test('treats a replacement operation as newer than the previous artifact', () => {
    const resolution = (status: 'queued' | 'running' | 'succeeded' | 'failed'): PdfLayoutResolution => ({
      artifact: { objectKey: 'parsed/existing.json' },
      operation: { status } as NonNullable<PdfLayoutResolution['operation']>,
    });

    expect(shouldPreferCurrentPdfParseOperation(resolution('queued'))).toBe(true);
    expect(shouldPreferCurrentPdfParseOperation(resolution('running'))).toBe(true);
    expect(shouldPreferCurrentPdfParseOperation(resolution('failed'))).toBe(true);
    expect(shouldPreferCurrentPdfParseOperation(resolution('succeeded'))).toBe(false);
    expect(shouldPreferCurrentPdfParseOperation({
      artifact: { objectKey: 'parsed/existing.json' },
      operation: null,
    })).toBe(false);
  });
});
