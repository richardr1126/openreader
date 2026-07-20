import { createHash } from 'node:crypto';
import pino, { type Logger } from 'pino';
import pinoPretty from 'pino-pretty';

export type TtsLogger = Logger;

export type LoggedError = {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: LoggedError | { message: string };
};

const LOG_FORMAT = process.env.LOG_FORMAT?.trim().toLowerCase() || 'pretty';
const LOG_LEVEL = process.env.LOG_LEVEL?.trim() || 'info';

function buildLoggerConfig(): pino.LoggerOptions {
  return {
    level: LOG_LEVEL,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };
}

function createTtsLogger(): TtsLogger {
  const config = buildLoggerConfig();
  if (LOG_FORMAT === 'json') return pino(config);

  return pino(config, pinoPretty({
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
    errorLikeObjectKeys: ['error'],
    customPrettifiers: {
      error(value) {
        if (!value || typeof value !== 'object') return String(value);
        const error = value as Record<string, unknown>;
        const lines: string[] = [];
        if (typeof error.message === 'string' && error.message) lines.push(`error.message: ${error.message}`);
        if (typeof error.code === 'string' && error.code) lines.push(`error.code: ${error.code}`);
        if (typeof error.name === 'string' && error.name) lines.push(`error.name: ${error.name}`);
        if (typeof error.stack === 'string' && error.stack) lines.push(`error.stack:\n${error.stack}`);
        if (error.cause !== undefined) {
          const causeText = typeof error.cause === 'object'
            ? JSON.stringify(error.cause)
            : String(error.cause);
          lines.push(`error.cause: ${causeText}`);
        }
        return lines.length > 0 ? lines.join('\n') : JSON.stringify(error);
      },
    },
  }));
}

export const ttsLogger = createTtsLogger();

function normalizeErrorCode(code: unknown): string | undefined {
  if (typeof code === 'string' && code.trim()) return code.trim();
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return undefined;
}

function serializeErrorCause(cause: unknown, depth: number): LoggedError | { message: string } {
  if (depth >= 3) return { message: String(cause) };
  if (cause instanceof Error) return errorToLog(cause, depth + 1);
  if (cause && typeof cause === 'object') {
    const rec = cause as Record<string, unknown>;
    const message = typeof rec.message === 'string' ? rec.message : String(cause);
    const name = typeof rec.name === 'string' && rec.name ? rec.name : 'ErrorCause';
    const code = normalizeErrorCode(rec.code);
    const stack = typeof rec.stack === 'string' ? rec.stack : undefined;
    const nestedCause = rec.cause !== undefined ? serializeErrorCause(rec.cause, depth + 1) : undefined;
    return {
      name,
      message,
      ...(code ? { code } : {}),
      ...(stack ? { stack } : {}),
      ...(nestedCause ? { cause: nestedCause } : {}),
    };
  }
  return { message: String(cause) };
}

export function errorToLog(error: unknown, depth = 0): LoggedError {
  if (error instanceof Error) {
    const rec = error as Error & { code?: unknown; cause?: unknown };
    const code = normalizeErrorCode(rec.code);
    const cause = rec.cause !== undefined ? serializeErrorCause(rec.cause, depth) : undefined;
    return {
      name: error.name || 'Error',
      message: error.message || 'Unknown error',
      ...(code ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(cause ? { cause } : {}),
    };
  }
  return {
    name: 'NonErrorThrowable',
    message: String(error),
  };
}

export function hashForLog(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function logTtsError(
  logger: TtsLogger,
  input: {
    event: string;
    error: unknown;
    msg: string;
    context?: Record<string, unknown>;
    normalize?: { code?: string; errorClass?: string };
  },
): void {
  logger.error({
    event: input.event,
    ...(input.context || {}),
    ...(input.normalize?.errorClass ? { errorClass: input.normalize.errorClass } : {}),
    error: {
      ...errorToLog(input.error),
      ...(input.normalize?.code ? { code: input.normalize.code } : {}),
    },
  }, input.msg);
}
