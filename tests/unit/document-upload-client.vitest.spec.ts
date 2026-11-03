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

    const id = '123e4567-e89b-12d3-a456-426614174000';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/uploads') return Response.json({ id, url: 'https://uploads.example/sample.docx', headers: {} });
      if (url === 'https://uploads.example/sample.docx' && init?.method === 'PUT') return new Response(null, { status: 200 });
      if (url === '/api/v1/documents') return Response.json({ id, status: 'processing', statusUrl: `/api/v1/uploads/${id}`,
        eventsUrl: `/api/v1/uploads/${id}/events?opId=op-1`, operationId: 'op-1', document: null }, { status: 202 });
      if (url === `/api/v1/uploads/${id}`) return Response.json({ id, status: 'ready', document: {
        id: 'a'.repeat(64), name: 'sample.pdf', type: 'pdf', size: 42, lastModified: 1, scope: 'user',
      } });
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
      '/api/v1/uploads/123e4567-e89b-12d3-a456-426614174000/events?opId=op-1',
    ]);
    const finalizationBodies = fetchMock.mock.calls
      .filter(([candidate]) => String(candidate) === '/api/v1/documents')
      .map(([, init]) => JSON.parse(String(init?.body)) as { folderId?: string });
    expect(finalizationBodies).toEqual([
      { folderId: 'reading-list', source: { type: 'upload', uploadId: id } },
    ]);
    expect(closedSources).toEqual([{ closed: true }]);
    expect(progressEvents).toContainEqual({
      phase: 'processing',
      sourceIndex: 0,
      operationStatus: 'running',
      workerPhase: 'converting',
    });
  });

  test('reads the conversion status at once when its event stream closes for good', async () => {
    class ClosedEventSource {
      static readonly CLOSED = 2;
      readonly readyState = ClosedEventSource.CLOSED;
      onerror: (() => void) | null = null;
      constructor() { queueMicrotask(() => this.onerror?.()); }
      addEventListener() {}
      close() {}
    }
    const id = '123e4567-e89b-12d3-a456-426614174000';
    vi.stubGlobal('EventSource', ClosedEventSource);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/uploads') return Response.json({ id, url: 'https://uploads.example/sample.docx', headers: {} });
      if (init?.method === 'PUT') return new Response(null, { status: 200 });
      if (url === '/api/v1/documents') return Response.json({ id, status: 'processing', statusUrl: `/api/v1/uploads/${id}`,
        eventsUrl: `/api/v1/uploads/${id}/events?opId=op-1`, operationId: 'op-1', document: null }, { status: 202 });
      return Response.json({ id, status: 'failed', error: 'Conversion failed.', document: null });
    }));

    await expect(uploadDocumentSources([{
      name: 'sample.docx', type: 'docx', size: 3, lastModified: 1,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: new Uint8Array([1, 2, 3]),
    }])).rejects.toThrow('Conversion failed.');
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
      if (url === '/api/v1/uploads') return Response.json({ id: '123e4567-e89b-12d3-a456-426614174000',
        url: 'https://uploads.example/notes.md', headers: { 'x-upload-token': 'signed' } });
      if (url === '/api/v1/documents') return Response.json({ id: 'b'.repeat(64), name: 'notes.md', type: 'html', size: 4, lastModified: 1, scope: 'user' }, { status: 201 });
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
      { phase: 'source-complete', sourceIndex: 0 },
      { phase: 'complete' },
    ]);
  });
});
