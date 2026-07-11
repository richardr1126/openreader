import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type SnapshotListener = (event: Event) => void;

class MockMessageEvent extends Event {
  data: string;

  constructor(type: string, init: { data: string }) {
    super(type);
    this.data = init.data;
  }
}

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  readonly listeners = new Map<string, SnapshotListener[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: SnapshotListener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, payload: unknown): void {
    const event = new MockMessageEvent(type, {
      data: JSON.stringify(payload),
    });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('PDF parse client lifecycle', () => {
  const originalFetch = global.fetch;
  const originalEventSource = global.EventSource;
  const originalMessageEvent = global.MessageEvent;

  beforeEach(() => {
    MockEventSource.instances = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/api/documents/doc-1/parsed') && method === 'GET') {
        fetchMock.getCount = (fetchMock.getCount ?? 0) + 1;
        if (fetchMock.getCount === 1) {
          return new Response(JSON.stringify({
            parseStatus: 'pending',
            parseProgress: null,
            opId: null,
          }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          parseStatus: 'ready',
          parseProgress: null,
          opId: null,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/api/documents/doc-1/parsed/download') && method === 'GET') {
        return new Response(JSON.stringify({ documentId: 'doc-1', pages: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/api/documents/doc-1/parsed') && method === 'POST') {
        return new Response(JSON.stringify({
          parseStatus: 'pending',
          parseProgress: null,
          opId: 'op-1',
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch & { getCount?: number };

    global.fetch = fetchMock;
    global.EventSource = MockEventSource as unknown as typeof EventSource;
    global.MessageEvent = MockMessageEvent as unknown as typeof MessageEvent;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
    global.MessageEvent = originalMessageEvent;
  });

  test('follows not-ready -> ensure op -> SSE snapshots -> ready artifact', async () => {
    const {
      ParsedPdfNotReadyError,
      ensureParsedPdfDocumentOperation,
      getParsedPdfDocument,
      subscribeParsedPdfDocumentEvents,
    } = await import('../../src/lib/client/api/documents');

    let initialError: unknown;
    try {
      await getParsedPdfDocument('doc-1');
    } catch (error) {
      initialError = error;
    }

    expect(initialError).toBeInstanceOf(ParsedPdfNotReadyError);
    expect((initialError as InstanceType<typeof ParsedPdfNotReadyError>).parseStatus).toBe('pending');

    const ensured = await ensureParsedPdfDocumentOperation('doc-1');
    expect(ensured).toMatchObject({
      parseStatus: 'pending',
      opId: 'op-1',
    });

    const snapshots: Array<{ parseStatus: string; opId?: string | null }> = [];
    const unsubscribe = subscribeParsedPdfDocumentEvents('doc-1', { opId: 'op-1' }, {
      onSnapshot: (snapshot) => {
        snapshots.push({
          parseStatus: snapshot.parseStatus,
          opId: snapshot.opId,
        });
      },
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe('/api/documents/doc-1/parsed/events?opId=op-1');

    MockEventSource.instances[0]?.emit('snapshot', {
      eventId: 1,
      snapshot: {
        opId: 'op-1',
        status: 'running',
        progress: { totalPages: 5, pagesParsed: 2, currentPage: 3, phase: 'infer' },
      },
    });
    MockEventSource.instances[0]?.emit('snapshot', {
      eventId: 2,
      snapshot: {
        opId: 'op-1',
        status: 'succeeded',
      },
    });

    expect(snapshots).toEqual([
      { parseStatus: 'running', opId: 'op-1' },
      { parseStatus: 'ready', opId: 'op-1' },
    ]);

    unsubscribe();
    expect(MockEventSource.instances[0]?.closed).toBe(true);

    const parsed = await getParsedPdfDocument('doc-1');
    expect(parsed).toMatchObject({ documentId: 'doc-1' });
  });
});
