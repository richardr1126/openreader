import type { ServerErrorClass } from '@/lib/server/errors/contract';

export type ServerErrorCatalogEntry = {
  code: string;
  errorClass: ServerErrorClass;
  httpStatus: number;
  retryable: boolean;
  ownerDomain: string;
  description: string;
};

export const SERVER_ERROR_CATALOG: ServerErrorCatalogEntry[] = [
  {
    code: 'UPSTREAM_RATE_LIMIT',
    errorClass: 'upstream',
    httpStatus: 429,
    retryable: true,
    ownerDomain: 'tts',
    description: 'Upstream provider rate limited the request.',
  },
  {
    code: 'UPSTREAM_TTS_ERROR',
    errorClass: 'upstream',
    httpStatus: 502,
    retryable: true,
    ownerDomain: 'tts',
    description: 'Upstream TTS provider returned a 5xx/transport failure.',
  },
  {
    code: 'DOCUMENTS_BLOB_MISSING',
    errorClass: 'storage',
    httpStatus: 404,
    retryable: false,
    ownerDomain: 'documents',
    description: 'Document blob was not found in backing storage.',
  },
  {
    code: 'COMPUTE_WORKER_UNAVAILABLE',
    errorClass: 'upstream',
    httpStatus: 503,
    retryable: true,
    ownerDomain: 'compute',
    description: 'Compute worker endpoint unavailable or misconfigured.',
  },
  {
    code: 'AUTH_UNAUTHORIZED',
    errorClass: 'auth',
    httpStatus: 401,
    retryable: false,
    ownerDomain: 'auth',
    description: 'Request requires authentication and no valid session was present.',
  },
  {
    code: 'UNKNOWN_SERVER_ERROR',
    errorClass: 'unknown',
    httpStatus: 500,
    retryable: false,
    ownerDomain: 'server',
    description: 'Fallback classification for uncategorized server exceptions.',
  },
];

export const SERVER_ERROR_CATALOG_BY_CODE = new Map(
  SERVER_ERROR_CATALOG.map((entry) => [entry.code, entry] as const),
);
