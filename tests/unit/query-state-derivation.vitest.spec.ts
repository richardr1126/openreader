import { describe, expect, test } from 'vitest';
import { combineQueryStates, deriveQueryState } from '../../src/lib/client/query/query-state';
import { ApiError, parseApiError } from '../../src/lib/client/api/http';

describe('deriveQueryState', () => {
  test('initial pending with no data is blocking initialLoading', () => {
    const s = deriveQueryState({ hasData: false, isFetching: true, isError: false, error: null });
    expect(s.initialLoading).toBe(true);
    expect(s.refreshing).toBe(false);
    expect(s.error).toBeNull();
    expect(s.backgroundError).toBeNull();
  });

  test('refetch with existing data is non-blocking refreshing, not error', () => {
    const s = deriveQueryState({ hasData: true, isFetching: true, isError: false, error: null });
    expect(s.initialLoading).toBe(false);
    expect(s.refreshing).toBe(true);
    expect(s.error).toBeNull();
  });

  test('error with no data is a hard error', () => {
    const err = new Error('boom');
    const s = deriveQueryState({ hasData: false, isFetching: false, isError: true, error: err });
    expect(s.error).toBe(err);
    expect(s.backgroundError).toBeNull();
    expect(s.initialLoading).toBe(false);
  });

  test('error while data exists is a soft background error', () => {
    const err = new Error('refresh failed');
    const s = deriveQueryState({ hasData: true, isFetching: false, isError: true, error: err });
    expect(s.error).toBeNull();
    expect(s.backgroundError).toBe(err);
  });
});

describe('combineQueryStates', () => {
  test('blocks while any required query is initially loading', () => {
    const state = combineQueryStates([
      deriveQueryState({ hasData: true, isFetching: false, isError: false, error: null }),
      deriveQueryState({ hasData: false, isFetching: true, isError: false, error: null }),
    ]);
    expect(state.initialLoading).toBe(true);
    expect(state.error).toBeNull();
  });

  test('surfaces a hard dependency error and preserves background warnings', () => {
    const hardError = new Error('folders failed');
    const backgroundError = new Error('preferences refresh failed');
    const state = combineQueryStates([
      deriveQueryState({ hasData: false, isFetching: false, isError: true, error: hardError }),
      deriveQueryState({ hasData: true, isFetching: false, isError: true, error: backgroundError }),
    ]);
    expect(state.error).toBe(hardError);
    expect(state.backgroundError).toBe(backgroundError);
  });

  test('marks the view refreshing while any populated query refetches', () => {
    const state = combineQueryStates([
      deriveQueryState({ hasData: true, isFetching: true, isError: false, error: null }),
      deriveQueryState({ hasData: true, isFetching: false, isError: false, error: null }),
    ]);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(true);
  });
});

describe('parseApiError', () => {
  test('reads server { error } message and status', async () => {
    const res = new Response(JSON.stringify({ error: 'Not allowed' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    const err = await parseApiError(res, 'Request failed');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe('Not allowed');
  });

  test('falls back to a status-tagged message for non-JSON bodies', async () => {
    const res = new Response('Bad gateway', { status: 502 });
    const err = await parseApiError(res, 'Request failed');
    expect(err.status).toBe(502);
    expect(err.message).toBe('Request failed (status 502)');
  });
});
