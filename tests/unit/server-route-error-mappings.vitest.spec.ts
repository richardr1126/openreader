import { describe, expect, test } from 'vitest';
import { AdminProviderError } from '../../src/lib/server/admin/providers';
import { errorResponse } from '../../src/lib/server/errors/next-response';
import { makeServerErrorContext } from './support/factories';

describe('route error mapping contract', () => {
  test('admin provider validation errors map to 4xx via route normalize policy', async () => {
    const adminError = new AdminProviderError('slug is required', 400);
    const response = errorResponse(adminError, {
      apiErrorMessage: adminError.message,
      normalize: makeServerErrorContext({
        code: 'ADMIN_PROVIDERS_CREATE_REQUEST_FAILED',
        errorClass: 'validation',
        httpStatus: adminError.status,
        retryable: false,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'slug is required',
      errorCode: 'ADMIN_PROVIDERS_CREATE_REQUEST_FAILED',
      retryable: false,
    });
  });

  test.each([
    {
      name: 'documents storage failures map to retryable 503',
      thrown: new Error('blobstore timeout'),
      apiErrorMessage: 'Failed to fetch document blob',
      normalize: makeServerErrorContext({
        code: 'DOCUMENT_BLOB_FETCH_FAILED',
        errorClass: 'storage',
      }),
      expectedStatus: 503,
      expectedBody: {
        error: 'Failed to fetch document blob',
        errorCode: 'DOCUMENT_BLOB_FETCH_FAILED',
        retryable: true,
      },
    },
    {
      name: 'user export auth initialization failure maps to 500 auth classification',
      thrown: new Error('Auth not initialized'),
      apiErrorMessage: 'Auth not initialized',
      normalize: makeServerErrorContext({
        code: 'USER_EXPORT_AUTH_NOT_INITIALIZED',
        errorClass: 'auth',
        httpStatus: 500,
        retryable: false,
      }),
      expectedStatus: 500,
      expectedBody: {
        error: 'Auth not initialized',
        errorCode: 'USER_EXPORT_AUTH_NOT_INITIALIZED',
        retryable: false,
      },
    },
  ])('$name', async ({ thrown, apiErrorMessage, normalize, expectedStatus, expectedBody }) => {
    const response = errorResponse(thrown, { apiErrorMessage, normalize });
    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toEqual(expectedBody);
  });
});
