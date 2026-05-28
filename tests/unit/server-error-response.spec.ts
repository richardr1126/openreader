import { expect, test } from '@playwright/test';
import { errorResponse } from '../../src/lib/server/errors/next-response';
import { createServerAppError } from '../../src/lib/server/errors/contract';

test.describe('server error response helper', () => {
  test('returns mapped 4xx response with explicit app code', async () => {
    const response = errorResponse(
      createServerAppError({
        code: 'AUTH_UNAUTHORIZED',
        message: 'Unauthorized',
        errorClass: 'auth',
        httpStatus: 401,
        retryable: false,
      }),
      {
        apiErrorMessage: 'Unauthorized',
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized',
      errorCode: 'AUTH_UNAUTHORIZED',
      retryable: false,
    });
  });

  test('normalizes unknown errors to safe 500 without stack leakage', async () => {
    const response = errorResponse(new Error('sensitive internal details'), {
      apiErrorMessage: 'Internal Server Error',
      normalize: { code: 'UNKNOWN_SERVER_ERROR', errorClass: 'unknown' },
    });
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'Internal Server Error',
      errorCode: 'UNKNOWN_SERVER_ERROR',
      retryable: false,
    });
    expect(JSON.stringify(body)).not.toContain('stack');
    expect(JSON.stringify(body)).not.toContain('cause');
  });
});
