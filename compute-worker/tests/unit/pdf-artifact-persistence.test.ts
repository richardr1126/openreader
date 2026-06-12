import { describe, expect, test, vi } from 'vitest';
import { persistParsedPdfWhileSourceExists } from '../../src/pdf-artifact-persistence';

describe('PDF artifact persistence', () => {
  test('does not write parsed output after the source was deleted', async () => {
    const putParsedObject = vi.fn(async () => 'parsed.json');

    await expect(persistParsedPdfWhileSourceExists({
      sourceObjectKey: 'document.pdf',
      sourceExists: async () => false,
      putParsedObject,
      deleteParsedObject: async () => undefined,
    })).rejects.toThrow('before parsed output');

    expect(putParsedObject).not.toHaveBeenCalled();
  });

  test('removes parsed output when the source disappears during the write', async () => {
    const sourceExists = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const deleteParsedObject = vi.fn(async () => undefined);

    await expect(persistParsedPdfWhileSourceExists({
      sourceObjectKey: 'document.pdf',
      sourceExists,
      putParsedObject: async () => 'parsed.json',
      deleteParsedObject,
    })).rejects.toThrow('while parsed output');

    expect(deleteParsedObject).toHaveBeenCalledWith('parsed.json');
  });
});
