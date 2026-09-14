import { afterEach, describe, expect, test, vi } from 'vitest';

import { uploadDocumentSources } from '@/lib/client/api/documents';

describe('document upload client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('waits for DOCX conversion SSE before registering the converted PDF', async () => {
    const eventUrls: string[] = [];
    const closedSources: Array<{ closed: boolean }> = [];
    const progressEvents: Array<Record<string, unknown>> = [];
    class MockEventSource {
      static readonly CLOSED = 2;
      readonly state = { closed: false };

      constructor(url: string | URL) {
        eventUrls.push(String(url));
        closedSources.push(this.state);
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type !== 'snapshot') return;
        queueMicrotask(() => {
          const runningEvent = new MessageEvent('snapshot', {
            data: JSON.stringify({
              eventId: 1,
              snapshot: {
                opId: 'op-1',
                status: 'running',
                progress: { phase: 'converting' },
              },
            }),
          });
          const succeededEvent = new MessageEvent('snapshot', {
            data: JSON.stringify({
              eventId: 2,
              snapshot: { opId: 'op-1', status: 'succeeded' },
            }),
          });
          if (typeof listener === 'function') {
            listener(runningEvent);
            listener(succeededEvent);
          } else {
            listener.handleEvent(runningEvent);
            listener.handleEvent(succeededEvent);
          }
        });
      }

      close() {
        this.state.closed = true;
      }
    }

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/documents/blob/upload') {
        return Response.json({
          uploads: [{
            token: '123e4567-e89b-12d3-a456-426614174000',
            url: 'https://uploads.example/sample.docx',
          }],
        });
      }
      if (url === 'https://uploads.example/sample.docx' && init?.method === 'PUT') {
        return new Response(null, { status: 200 });
      }
      if (url === '/api/documents/blob/upload/finalize') {
        const finalizeCalls = fetchMock.mock.calls.filter(([candidate]) => (
          String(candidate) === '/api/documents/blob/upload/finalize'
        )).length;
        if (finalizeCalls === 1) {
          return Response.json({
            stored: [],
            conversions: [{
              token: '123e4567-e89b-12d3-a456-426614174000',
              name: 'sample.docx',
              conversionId: 'conversion-1',
              opId: 'op-1',
              status: 'running',
            }],
          }, { status: 202 });
        }
        return Response.json({
          stored: [{
            id: 'a'.repeat(64),
            name: 'sample.pdf',
            type: 'pdf',
            size: 42,
            lastModified: 1,
            scope: 'user',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource);

    await expect(uploadDocumentSources([{
      name: 'sample.docx',
      type: 'docx',
      size: 3,
      lastModified: 1,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: new Uint8Array([1, 2, 3]),
    }], {
      folderId: 'reading-list',
      onProgress: (event) => progressEvents.push(event),
    })).resolves.toEqual([expect.objectContaining({
      id: 'a'.repeat(64),
      name: 'sample.pdf',
      type: 'pdf',
    })]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(eventUrls).toEqual([
      '/api/documents/blob/upload/events?opId=op-1&token=123e4567-e89b-12d3-a456-426614174000',
    ]);
    const finalizationBodies = fetchMock.mock.calls
      .filter(([candidate]) => String(candidate) === '/api/documents/blob/upload/finalize')
      .map(([, init]) => JSON.parse(String(init?.body)) as { folderId?: string });
    expect(finalizationBodies).toEqual([
      { folderId: 'reading-list', uploads: expect.any(Array) },
      { folderId: 'reading-list', uploads: expect.any(Array) },
    ]);
    expect(closedSources).toEqual([{ closed: true }]);
    expect(progressEvents).toContainEqual({
      phase: 'processing',
      sourceIndex: 0,
      operationStatus: 'running',
      workerPhase: 'converting',
    });
  });

  test('reports byte-level storage transfer progress through XMLHttpRequest', async () => {
    const progressEvents: Array<Record<string, unknown>> = [];
    const requestHeaders: Record<string, string> = {};

    class MockXmlHttpRequest {
      status = 200;
      upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      open(method: string, url: string) {
        expect({ method, url }).toEqual({ method: 'PUT', url: 'https://uploads.example/notes.md' });
      }

      setRequestHeader(name: string, value: string) {
        requestHeaders[name] = value;
      }

      send() {
        queueMicrotask(() => {
          this.upload.onprogress?.({ loaded: 2 });
          this.onload?.();
        });
      }

      abort() {
        this.onabort?.();
      }
    }

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/documents/blob/upload') {
        return Response.json({
          uploads: [{
            token: '123e4567-e89b-12d3-a456-426614174000',
            url: 'https://uploads.example/notes.md',
            headers: { 'x-upload-token': 'signed' },
          }],
        });
      }
      if (url === '/api/documents/blob/upload/finalize') {
        return Response.json({
          stored: [{
            id: 'b'.repeat(64),
            name: 'notes.md',
            type: 'html',
            size: 4,
            lastModified: 1,
            scope: 'user',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);

    await uploadDocumentSources([{
      name: 'notes.md',
      type: 'html',
      size: 4,
      lastModified: 1,
      contentType: 'text/markdown',
      body: new Uint8Array([1, 2, 3, 4]),
    }], {
      onProgress: (event) => progressEvents.push(event),
    });

    expect(requestHeaders).toEqual({ 'x-upload-token': 'signed' });
    expect(progressEvents).toEqual([
      { phase: 'preparing' },
      { phase: 'transferring', sourceIndex: 0, loadedBytes: 0, totalBytes: 4 },
      { phase: 'transferring', sourceIndex: 0, loadedBytes: 2, totalBytes: 4 },
      { phase: 'transferring', sourceIndex: 0, loadedBytes: 4, totalBytes: 4 },
      { phase: 'finalizing' },
      { phase: 'complete' },
    ]);
  });
});
