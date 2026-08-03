import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type EventListener = (event: Event) => void;

class MockMessageEvent extends Event {
  constructor(type: string, readonly data: string) {
    super(type);
  }
}

class MockEventSource {
  static instances: MockEventSource[] = [];

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

  close(): void {
    this.closed = true;
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
});
