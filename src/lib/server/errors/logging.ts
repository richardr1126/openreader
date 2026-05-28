import type { ServerLogger } from '@/lib/server/logger';
import { errorToLog } from '@/lib/server/logger';
import { normalizeServerError, type NormalizedServerError, type ServerErrorContext } from '@/lib/server/errors/contract';

type LogContext = Record<string, unknown>;

export function logServerError(
  logger: ServerLogger,
  input: {
    event: string;
    error: unknown;
    msg: string;
    context?: LogContext;
    normalize?: ServerErrorContext;
  },
): NormalizedServerError {
  const normalized = normalizeServerError(input.error, input.normalize);
  logger.error({
    event: input.event,
    ...(input.context || {}),
    error: {
      ...errorToLog(input.error),
      code: normalized.code,
    },
  }, `${input.msg}`);
  return normalized;
}

export function logDegraded(
  logger: ServerLogger,
  input: {
    event: string;
    msg: string;
    step?: string;
    fallbackPath?: string;
    context?: LogContext;
    error?: unknown;
  },
): void {
  logger.warn({
    event: input.event,
    degraded: true,
    ...(input.step ? { step: input.step } : {}),
    ...(input.fallbackPath ? { fallbackPath: input.fallbackPath } : {}),
    ...(input.context || {}),
    ...(input.error !== undefined ? { error: errorToLog(input.error) } : {}),
  }, `${input.msg}`);
}
