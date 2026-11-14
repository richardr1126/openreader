import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type EventListener = (event: Event) => void;

class MockMessageEvent extends Event {
  constructor(type: string, readonly data: string) {
    super(type);
  }
}

class MockEventSource {
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = 0;

  readonly listeners = new Map<string, EventListener[]>();
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, payload: unknown): void {
    const event = new MockMessageEvent(type, JSON.stringify(payload));
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(): void {
    this.readyState = MockEventSource.CLOSED;
    for (const listener of this.listeners.get('error') ?? []) listener(new Event('error'));
  }

  close(): void {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('reader bootstrap restart client', () => {
  const originalFetch = global.fetch;
  const originalEventSource = global.EventSource;
  const originalMessageEvent = global.MessageEvent;

  beforeEach(() => {
    MockEventSource.instances = [];
    global.EventSource = MockEventSource as unknown as typeof EventSource;
    global.MessageEvent = MockMessageEvent as unknown as typeof MessageEvent;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
    global.MessageEvent = originalMessageEvent;
  });

  test('turns force-reparse into one aggregate restart stream', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      parseStatus: 'running',
      parseProgress: {
        phase: 'infer',
        pagesParsed: 2,
        totalPages: 5,
      },
      opId: 'parse-op',
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { forceReparsePdfDocument } = await import('@/lib/client/api/documents');
    const { subscribeReaderBootstrap } = await import('@/lib/client/api/reader-bootstrap');
    const restart = await forceReparsePdfDocument('doc-1');

    expect(restart).toEqual({
      operationId: 'parse-op',
      progress: {
        kind: 'pdf-parse',
        phase: 'parsing',
        pagesParsed: 2,
        totalPages: 5,
      },
    });

    const snapshots: string[] = [];
    const unsubscribe = subscribeReaderBootstrap('doc-1', (snapshot) => {
      snapshots.push(snapshot.status);
    }, { operationId: restart.operationId });
    const source = MockEventSource.instances[0];
    expect(source?.url).toBe(
      '/api/documents/doc-1/reader-bootstrap/events?operationId=parse-op',
    );

    source?.emit('snapshot', { status: 'pending', progress: restart.progress });
    source?.emit('snapshot', { status: 'ready', payload: {} });
    expect(snapshots).toEqual(['pending', 'ready']);
    expect(source?.closed).toBe(true);

    unsubscribe();
  });

  test('reopens a stream the browser closed and settles after repeated failures', async () => {
    vi.useFakeTimers();
    try {
      const { subscribeReaderBootstrap } = await import('@/lib/client/api/reader-bootstrap');
      const snapshots: unknown[] = [];
      const unsubscribe = subscribeReaderBootstrap('doc-1', (snapshot) => {
        snapshots.push(snapshot);
      });

      // A non-200 reconnect (an upstream 502) closes the browser's source.
      MockEventSource.instances[0]?.fail();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(MockEventSource.instances).toHaveLength(2);
      MockEventSource.instances[1]?.emit('snapshot', { status: 'ready', payload: {} });
      expect(snapshots).toEqual([{ status: 'ready', payload: {} }]);
      unsubscribe();

      snapshots.length = 0;
      MockEventSource.instances = [];
      const stop = subscribeReaderBootstrap('doc-2', (snapshot) => {
        snapshots.push(snapshot);
      });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        MockEventSource.instances.at(-1)?.fail();
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(MockEventSource.instances).toHaveLength(6);
      expect(snapshots).toEqual([{
        status: 'error',
        message: 'Lost connection while preparing the reader.',
        retryable: true,
      }]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
