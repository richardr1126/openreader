import { describe, expect, test } from 'vitest';
import { deriveReaderLoadState } from '../../src/lib/client/reader-load';
import type { ReaderBootstrapResult } from '../../src/types/reader-bootstrap';

const pending: ReaderBootstrapResult = { status: 'pending' };
const ready = { status: 'ready', payload: {} } as ReaderBootstrapResult;

describe('reader load presentation', () => {
  test('waits for the aggregate server bootstrap before client rendering', () => {
    expect(deriveReaderLoadState({
      bootstrap: pending,
      sourceStatus: 'idle',
      viewerReady: false,
    })).toMatchObject({ blocking: true, error: null });
  });

  test('keeps renderer mechanics in their natural order after bootstrap', () => {
    expect(deriveReaderLoadState({
      bootstrap: ready,
      sourceStatus: 'ready',
      parseStatus: 'running',
      viewerReady: false,
    })).toMatchObject({ blocking: true, error: null });

    expect(deriveReaderLoadState({
      bootstrap: ready,
      sourceStatus: 'ready',
      viewerReady: false,
    })).toMatchObject({ blocking: true, error: null });
  });

  test('only becomes non-blocking after the renderer is ready', () => {
    expect(deriveReaderLoadState({
      bootstrap: ready,
      sourceStatus: 'ready',
      viewerReady: true,
    })).toMatchObject({ blocking: false, error: null });
  });

  test('uses the aggregate retry policy for server errors', () => {
    const state = deriveReaderLoadState({
      bootstrap: { status: 'error', message: 'worker failed', retryable: true },
      sourceStatus: 'idle',
      viewerReady: false,
    });
    expect(state).toMatchObject({
      blocking: true,
      retryKind: 'bootstrap',
    });
    expect(state.error?.message).toBe('worker failed');
  });
});
