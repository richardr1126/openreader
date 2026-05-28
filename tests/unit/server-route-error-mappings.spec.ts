import { expect, test } from '@playwright/test';
import { errorResponse } from '../../src/lib/server/errors/next-response';
import { AdminProviderError } from '../../src/lib/server/admin/providers';

test.describe('route error mapping contract', () => {
  test('admin provider validation errors map to 4xx via route normalize policy', async () => {
    const adminError = new AdminProviderError('slug is required', 400);
    const response = errorResponse(adminError, {
      apiErrorMessage: adminError.message,
      normalize: {
        code: 'ADMIN_PROVIDERS_CREATE_REQUEST_FAILED',
        errorClass: 'validation',
        httpStatus: adminError.status,
        retryable: false,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'slug is required',
      errorCode: 'ADMIN_PROVIDERS_CREATE_REQUEST_FAILED',
      retryable: false,
    });
  });

  test('documents storage failures map to retryable 503', async () => {
    const response = errorResponse(new Error('blobstore timeout'), {
      apiErrorMessage: 'Failed to fetch document blob',
      normalize: {
        code: 'DOCUMENT_BLOB_FETCH_FAILED',
        errorClass: 'storage',
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to fetch document blob',
      errorCode: 'DOCUMENT_BLOB_FETCH_FAILED',
      retryable: true,
    });
  });

  test('audiobook upstream failures map to retryable 502', async () => {
    const response = errorResponse(new Error('provider overloaded'), {
      apiErrorMessage: 'Failed to process audio chapter',
      normalize: {
        code: 'AUDIOBOOK_CHAPTER_PROCESS_FAILED',
        errorClass: 'upstream',
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to process audio chapter',
      errorCode: 'AUDIOBOOK_CHAPTER_PROCESS_FAILED',
      retryable: true,
    });
  });

  test('user export auth initialization failure maps to 500 auth classification', async () => {
    const response = errorResponse(new Error('Auth not initialized'), {
      apiErrorMessage: 'Auth not initialized',
      normalize: {
        code: 'USER_EXPORT_AUTH_NOT_INITIALIZED',
        errorClass: 'auth',
        httpStatus: 500,
        retryable: false,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Auth not initialized',
      errorCode: 'USER_EXPORT_AUTH_NOT_INITIALIZED',
      retryable: false,
    });
  });
});
