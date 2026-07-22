import { describe, expect, test } from 'vitest';
import { deriveReaderLoadState } from '../../src/lib/client/reader-load';

const readyPlan = { status: 'ready' as const, error: null };

describe('deriveReaderLoadState', () => {
  test('uses the same ordered gates for every reader', () => {
    expect(deriveReaderLoadState({
      bootstrapPhase: 'loading-server-state',
      sourceStatus: 'idle',
      plan: { status: 'idle', error: null },
      viewerReady: false,
    }).phase).toBe('opening-document');

    expect(deriveReaderLoadState({
      bootstrapPhase: 'ready',
      sourceStatus: 'ready',
      parseStatus: 'running',
      plan: { status: 'idle', error: null },
      viewerReady: false,
    }).phase).toBe('understanding-structure');

    expect(deriveReaderLoadState({
      bootstrapPhase: 'ready',
      sourceStatus: 'ready',
      plan: { status: 'running', error: null },
      viewerReady: false,
    }).phase).toBe('preparing-reading-plan');

    expect(deriveReaderLoadState({
      bootstrapPhase: 'ready',
      sourceStatus: 'ready',
      plan: readyPlan,
      viewerReady: false,
    }).phase).toBe('setting-your-place');
  });

  test('only becomes non-blocking after the authoritative plan and viewer are ready', () => {
    const state = deriveReaderLoadState({
      bootstrapPhase: 'ready',
      sourceStatus: 'ready',
      plan: readyPlan,
      viewerReady: true,
    });
    expect(state).toMatchObject({ phase: 'ready', blocking: false, error: null });
  });

  test('keeps plan failure blocking with a plan-scoped retry', () => {
    const error = new Error('worker failed');
    expect(deriveReaderLoadState({
      bootstrapPhase: 'ready',
      sourceStatus: 'ready',
      plan: { status: 'failed', error },
      viewerReady: false,
    })).toMatchObject({
      phase: 'preparing-reading-plan',
      blocking: true,
      retryKind: 'plan',
      error,
    });
  });
});
