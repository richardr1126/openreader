import { expect, test } from '@playwright/test';
import {
  ServerAppError,
  createServerAppError,
  isServerAppError,
  normalizeServerError,
  toApiErrorBody,
  toHttpStatus,
} from '../../src/lib/server/errors/contract';

test.describe('server error contract', () => {
  test('normalizes unknown throwable to fallback shape', () => {
    const normalized = normalizeServerError('boom');
    expect(normalized.code).toBe('UNKNOWN_SERVER_ERROR');
    expect(normalized.errorClass).toBe('unknown');
    expect(normalized.httpStatus).toBe(500);
    expect(normalized.retryable).toBe(false);
    expect(normalized.message).toBe('boom');
  });

  test('preserves ServerAppError metadata', () => {
    const err = createServerAppError({
      code: 'USER_PROGRESS_UPDATE_FAILED',
      message: 'Failed to update progress',
      errorClass: 'db',
      retryable: true,
      httpStatus: 500,
      details: { operation: 'update_progress' },
    });
    const normalized = normalizeServerError(err);
    expect(isServerAppError(err)).toBe(true);
    expect(normalized.code).toBe('USER_PROGRESS_UPDATE_FAILED');
    expect(normalized.errorClass).toBe('db');
    expect(normalized.httpStatus).toBe(500);
    expect(normalized.retryable).toBe(true);
    expect(normalized.details?.operation).toBe('update_progress');
  });

  test('maps normalized errors to API body + status', () => {
    const normalized = normalizeServerError(
      new ServerAppError({
        code: 'UPSTREAM_TTS_ERROR',
        message: 'Upstream failure',
        errorClass: 'upstream',
      }),
    );
    const body = toApiErrorBody(normalized, { includeDetails: false });
    expect(body).toEqual({
      error: 'Upstream failure',
      errorCode: 'UPSTREAM_TTS_ERROR',
      retryable: true,
    });
    expect(toHttpStatus(normalized)).toBe(502);
  });
});
