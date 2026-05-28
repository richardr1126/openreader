import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { ServerLogger } from '@/lib/server/logger';
import { normalizeServerError, toApiErrorBody, toHttpStatus, type NormalizedServerError, type ServerErrorContext } from '@/lib/server/errors/contract';
import { logServerError } from '@/lib/server/errors/logging';

export type ErrorResponseOptions = {
  logger?: ServerLogger;
  event?: string;
  msg?: string;
  normalize?: ServerErrorContext;
  apiErrorMessage?: string;
  includeErrorCode?: boolean;
  includeRetryable?: boolean;
  includeDetails?: boolean;
};

export function errorResponse(
  error: unknown,
  options: ErrorResponseOptions = {},
): NextResponse {
  const normalized = normalizeServerError(error, options.normalize);
  if (options.logger && options.event && options.msg) {
    logServerError(options.logger, {
      event: options.event,
      error,
      msg: options.msg,
      context: {},
      normalize: options.normalize,
    });
  }
  const apiError = options.apiErrorMessage ?? normalized.message;
  const body = toApiErrorBody(
    { ...normalized, message: apiError },
    {
      includeErrorCode: options.includeErrorCode ?? true,
      includeRetryable: options.includeRetryable ?? true,
      includeDetails: options.includeDetails ?? false,
    },
  );
  return NextResponse.json(body, { status: toHttpStatus(normalized) });
}

export type ErrorBoundaryContext = {
  route: string;
  logger: ServerLogger;
  event: string;
  msg: string;
  normalize?: ServerErrorContext;
  apiErrorMessage?: string;
};

export function withErrorBoundary<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
  ctx: ErrorBoundaryContext,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResponse(error, {
        logger: ctx.logger,
        event: ctx.event,
        msg: ctx.msg,
        normalize: ctx.normalize,
        apiErrorMessage: ctx.apiErrorMessage,
      });
    }
  };
}

export function asRouteErrorContext(input: {
  request: NextRequest;
  route: string;
  method?: string;
  requestId?: string;
}): Record<string, unknown> {
  return {
    route: input.route,
    method: input.method ?? input.request.method,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  };
}

export function normalizeForResponseOnly(
  error: unknown,
  normalize?: ServerErrorContext,
): NormalizedServerError {
  return normalizeServerError(error, normalize);
}
