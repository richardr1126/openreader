import { NextResponse } from 'next/server';
import { isComputeWorkerUnavailableError } from '@/lib/server/compute-worker/client';
import { ComputeAdmissionLimitedError } from '@/lib/server/compute-limits/run-admitted';
import { normalizeServerError, toHttpStatus, type ServerErrorContext } from '@/lib/server/errors/contract';
import { logServerError } from '@/lib/server/errors/logging';
import type { ServerLogger } from '@/lib/server/logger';

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function apiErrorResponse(
  status: number,
  code: string,
  message: string,
  options: { retryAfterMs?: number } = {},
): NextResponse {
  const { retryAfterMs } = options;
  return NextResponse.json(
    { error: { code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } },
    {
      status,
      ...(retryAfterMs === undefined
        ? {}
        : { headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } }),
    },
  );
}

/** Maps a failure inside a v1 route to the public error shape. */
export function apiCatchResponse(
  error: unknown,
  options: { logger: ServerLogger; event: string; msg: string; normalize: ServerErrorContext },
): NextResponse {
  if (error instanceof ApiRequestError) return apiErrorResponse(error.status, error.code, error.message);
  if (error instanceof ComputeAdmissionLimitedError) {
    return apiErrorResponse(429, error.code, error.message, { retryAfterMs: error.retryAfterMs });
  }
  if (isComputeWorkerUnavailableError(error)) {
    options.logger.warn({
      event: `${options.event}.worker_unavailable`,
      error: error instanceof Error ? error.message : String(error),
    }, 'Compute worker unavailable');
    return apiErrorResponse(
      503,
      'COMPUTE_WORKER_UNAVAILABLE',
      'The compute worker is unavailable right now (it may be restarting). Try again in a moment.',
      { retryAfterMs: 5_000 },
    );
  }
  logServerError(options.logger, {
    event: options.event,
    error,
    msg: options.msg,
    context: {},
    normalize: options.normalize,
  });
  const normalized = normalizeServerError(error, options.normalize);
  return apiErrorResponse(toHttpStatus(normalized), normalized.code, options.msg);
}
