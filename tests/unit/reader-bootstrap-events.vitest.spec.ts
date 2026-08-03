import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ReaderBootstrapResolution } from '@/lib/server/reader/bootstrap';

const hoisted = vi.hoisted(() => ({
  openOperationEvents: vi.fn(),
  resolveReaderBootstrapState: vi.fn(),
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  getComputeWorkerClient: () => ({
    openOperationEvents: hoisted.openOperationEvents,
  }),
}));

vi.mock('@/lib/server/reader/bootstrap', () => ({
  resolveReaderBootstrapState: hoisted.resolveReaderBootstrapState,
}));

function operationSnapshot(operationId: string): Response {
  return new Response(
    `event: snapshot\ndata: {"snapshot":{"opId":"${operationId}","status":"succeeded"}}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}

describe('reader bootstrap aggregate event stream', () => {
  beforeEach(() => {
    hoisted.openOperationEvents.mockReset();
    hoisted.resolveReaderBootstrapState.mockReset();
  });

  test('moves from PDF parse observation to plan observation and emits full snapshots', async () => {
    const initial: ReaderBootstrapResolution = {
      result: {
        status: 'pending',
        progress: {
          kind: 'pdf-parse',
          phase: 'parsing',
          pagesParsed: 4,
          totalPages: 10,
        },
      },
      operationId: 'parse-op',
    };
    const planPending: ReaderBootstrapResolution = {
      result: { status: 'pending' },
      operationId: 'plan-op',
    };
    const ready: ReaderBootstrapResolution = {
      result: {
        status: 'ready',
        payload: {
          documentId: 'doc-1',
          readerType: 'pdf',
          document: {
            id: 'doc-1',
            name: 'Document',
            type: 'pdf',
            size: 1,
            lastModified: 1,
            contentVersion: 'doc-1',
            scope: 'user',
          },
          settings: {},
          plan: {
            schemaVersion: 1,
            planId: 'plan-op',
            documentId: 'doc-1',
            readerType: 'pdf',
            entries: [],
          },
          initialPosition: null,
        },
      },
    } as unknown as ReaderBootstrapResolution;
    hoisted.openOperationEvents
      .mockResolvedValueOnce(operationSnapshot('parse-op'))
      .mockResolvedValueOnce(operationSnapshot('plan-op'));
    hoisted.resolveReaderBootstrapState
      .mockResolvedValueOnce(planPending)
      .mockResolvedValueOnce(ready);

    const { createReaderBootstrapEventStream } = await import(
      '../../src/lib/server/reader/bootstrap-events'
    );
    const request = new NextRequest(
      'http://localhost/api/documents/doc-1/reader-bootstrap/events',
    );
    const resolveOptions = { preparationOperationId: 'parse-op' };
    const body = await new Response(
      createReaderBootstrapEventStream(request, 'doc-1', initial, resolveOptions),
    ).text();
    const snapshots = body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as {
        status: string;
        progress?: { kind: string; pagesParsed: number; totalPages: number };
      });

    expect(snapshots.map((snapshot) => snapshot.status)).toEqual([
      'pending',
      'pending',
      'ready',
    ]);
    expect(snapshots[0]?.progress).toEqual({
      kind: 'pdf-parse',
      phase: 'parsing',
      pagesParsed: 4,
      totalPages: 10,
    });
    expect(hoisted.openOperationEvents).toHaveBeenNthCalledWith(
      1,
      'parse-op',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(hoisted.openOperationEvents).toHaveBeenNthCalledWith(
      2,
      'plan-op',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(hoisted.resolveReaderBootstrapState).toHaveBeenNthCalledWith(
      1,
      request,
      'doc-1',
      resolveOptions,
    );
    expect(hoisted.resolveReaderBootstrapState).toHaveBeenNthCalledWith(
      2,
      request,
      'doc-1',
      resolveOptions,
    );
  });
});
