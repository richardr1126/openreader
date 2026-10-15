import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { convertDocxBufferToPdfBuffer } from '../../packages/compute-worker/src/inference/docx/convert';

describe('DOCX conversion', () => {
  const originalPath = process.env.PATH;
  let emptyDir: string | null = null;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (emptyDir) rmSync(emptyDir, { recursive: true, force: true });
    emptyDir = null;
  });

  test('says LibreOffice is missing when soffice is not on PATH', async () => {
    emptyDir = mkdtempSync(join(tmpdir(), 'openreader-no-soffice-'));
    process.env.PATH = emptyDir;
    await expect(convertDocxBufferToPdfBuffer(Buffer.from('not a real docx'))).rejects.toThrow(
      'DOCX conversion needs LibreOffice, which is not installed where OpenReader can find it.',
    );
  });
});
