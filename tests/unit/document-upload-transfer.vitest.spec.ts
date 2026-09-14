import { afterEach, describe, expect, test, vi } from 'vitest';

import { transferPreparedDocumentUploads } from '@/lib/client/uploads/transfer';

const sources = Array.from({ length: 5 }, (_, index) => ({
  name: `document-${index}.txt`,
  size: 1,
  body: new Uint8Array([index]),
}));
const uploads = Array.from({ length: 5 }, (_, index) => ({
  token: `token-${index}`,
  url: `https://uploads.example/document-${index}.txt`,
}));

describe('document upload transfer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('bounds simultaneous direct-storage transfers to three', async () => {
    let active = 0;
    let maxActive = 0;

    class MockXmlHttpRequest {
      status = 200;
      upload = { onprogress: null as ((event: { loaded: number }) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      open() {}
      setRequestHeader() {}
      abort() { this.onabort?.(); }
      send() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        queueMicrotask(() => {
          active -= 1;
          this.onload?.();
        });
      }
    }

    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);
    await transferPreparedDocumentUploads({
      sources,
      uploads,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(maxActive).toBe(3);
  });

  test('aborts every active transfer through the shared signal', async () => {
    let abortCount = 0;

    class MockXmlHttpRequest {
      status = 0;
      upload = { onprogress: null as ((event: { loaded: number }) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      open() {}
      setRequestHeader() {}
      send() {}
      abort() {
        abortCount += 1;
        this.onabort?.();
      }
    }

    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);
    const controller = new AbortController();
    const transfer = transferPreparedDocumentUploads({
      sources,
      uploads,
      signal: controller.signal,
      onProgress: () => undefined,
    });
    controller.abort(new DOMException('Cancelled by user', 'AbortError'));

    await expect(transfer).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortCount).toBe(3);
  });
});
