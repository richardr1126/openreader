import { afterEach, describe, expect, test, vi } from 'vitest';

import { uploadDocumentSources } from '@/lib/client/api/documents';

describe('document upload client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('waits for DOCX conversion SSE before registering the converted PDF', async () => {
    const eventUrls: string[] = [];
    const closedSources: Array<{ closed: boolean }> = [];
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
          const event = new MessageEvent('snapshot', {
            data: JSON.stringify({
              eventId: 2,
              snapshot: { opId: 'op-1', status: 'succeeded' },
            }),
          });
          if (typeof listener === 'function') listener(event);
          else listener.handleEvent(event);
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
    }])).resolves.toEqual([expect.objectContaining({
      id: 'a'.repeat(64),
      name: 'sample.pdf',
      type: 'pdf',
    })]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(eventUrls).toEqual([
      '/api/documents/blob/upload/events?opId=op-1&token=123e4567-e89b-12d3-a456-426614174000',
    ]);
    expect(closedSources).toEqual([{ closed: true }]);
  });
});
