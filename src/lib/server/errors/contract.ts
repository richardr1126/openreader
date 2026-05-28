export type ServerErrorClass =
  | 'validation'
  | 'auth'
  | 'permission'
  | 'upstream'
  | 'storage'
  | 'db'
  | 'timeout'
  | 'unknown';

type ServerErrorDefaults = {
  httpStatus: number;
  retryable: boolean;
};

const CLASS_DEFAULTS: Record<ServerErrorClass, ServerErrorDefaults> = {
  validation: { httpStatus: 400, retryable: false },
  auth: { httpStatus: 401, retryable: false },
  permission: { httpStatus: 403, retryable: false },
  upstream: { httpStatus: 502, retryable: true },
  storage: { httpStatus: 503, retryable: true },
  db: { httpStatus: 500, retryable: true },
  timeout: { httpStatus: 504, retryable: true },
  unknown: { httpStatus: 500, retryable: false },
};

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;

export type ServerErrorContext = {
  code?: string;
  message?: string;
  errorClass?: ServerErrorClass;
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export class ServerAppError extends Error {
  readonly code: string;
  readonly errorClass: ServerErrorClass;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    message: string;
    errorClass: ServerErrorClass;
    httpStatus?: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = 'ServerAppError';
    this.code = input.code;
    this.errorClass = input.errorClass;
    const defaults = CLASS_DEFAULTS[input.errorClass];
    this.httpStatus = input.httpStatus ?? defaults.httpStatus;
    this.retryable = input.retryable ?? defaults.retryable;
    if (input.details) this.details = input.details;
  }
}

export function isServerAppError(value: unknown): value is ServerAppError {
  return value instanceof ServerAppError;
}

function normalizeFromErrorInstance(error: Error): {
  message: string;
  code?: string;
  errorClass?: ServerErrorClass;
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
} {
  const rec = error as Error & {
    code?: unknown;
    errorClass?: unknown;
    httpStatus?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
  const code = typeof rec.code === 'string' && rec.code.trim() ? rec.code.trim() : undefined;
  const errorClass = typeof rec.errorClass === 'string' && rec.errorClass in CLASS_DEFAULTS
    ? rec.errorClass as ServerErrorClass
    : undefined;
  const httpStatus = typeof rec.httpStatus === 'number' && Number.isFinite(rec.httpStatus)
    ? Math.max(400, Math.min(599, Math.floor(rec.httpStatus)))
    : undefined;
  const retryable = typeof rec.retryable === 'boolean' ? rec.retryable : undefined;
  const details = rec.details && typeof rec.details === 'object'
    ? rec.details as Record<string, unknown>
    : undefined;
  return {
    message: error.message || 'Internal server error',
    ...(code ? { code } : {}),
    ...(errorClass ? { errorClass } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    ...(details ? { details } : {}),
  };
}

export type NormalizedServerError = {
  code: string;
  message: string;
  errorClass: ServerErrorClass;
  httpStatus: number;
  retryable: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export function normalizeServerError(
  error: unknown,
  ctx: ServerErrorContext = {},
): NormalizedServerError {
  if (isServerAppError(error)) {
    return {
      code: error.code,
      message: error.message,
      errorClass: error.errorClass,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
      ...(error.cause !== undefined ? { cause: error.cause } : {}),
    };
  }

  const normalizedFromThrowable = error instanceof Error ? normalizeFromErrorInstance(error) : {
    message: String(error),
  };

  const errorClass = ctx.errorClass
    ?? normalizedFromThrowable.errorClass
    ?? 'unknown';
  const defaults = CLASS_DEFAULTS[errorClass];

  const rawCode = ctx.code
      ?? normalizedFromThrowable.code
      ?? 'UNKNOWN_SERVER_ERROR';
  const code = ERROR_CODE_PATTERN.test(rawCode) ? rawCode : 'UNKNOWN_SERVER_ERROR';

  return {
    code,
    message: ctx.message
      ?? normalizedFromThrowable.message
      ?? 'Internal server error',
    errorClass,
    httpStatus: ctx.httpStatus
      ?? normalizedFromThrowable.httpStatus
      ?? defaults.httpStatus,
    retryable: ctx.retryable
      ?? normalizedFromThrowable.retryable
      ?? defaults.retryable,
    ...(ctx.details ? { details: ctx.details } : normalizedFromThrowable.details ? { details: normalizedFromThrowable.details } : {}),
    ...(error instanceof Error && error.cause !== undefined ? { cause: error.cause } : {}),
  };
}

export function toApiErrorBody(
  input: NormalizedServerError,
  options: {
    includeErrorCode?: boolean;
    includeRetryable?: boolean;
    includeDetails?: boolean;
  } = {},
): {
  error: string;
  errorCode?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
} {
  const includeErrorCode = options.includeErrorCode ?? true;
  const includeRetryable = options.includeRetryable ?? true;
  const includeDetails = options.includeDetails ?? true;
  return {
    error: input.message,
    ...(includeErrorCode ? { errorCode: input.code } : {}),
    ...(includeRetryable ? { retryable: input.retryable } : {}),
    ...(includeDetails && input.details ? { details: input.details } : {}),
  };
}

export function toHttpStatus(input: NormalizedServerError): number {
  return input.httpStatus;
}

export function createServerAppError(input: {
  code: string;
  message: string;
  errorClass: ServerErrorClass;
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}): ServerAppError {
  if (!ERROR_CODE_PATTERN.test(input.code)) {
    throw new Error(`Invalid ServerAppError code "${input.code}" (expected ${ERROR_CODE_PATTERN.toString()})`);
  }
  return new ServerAppError(input);
}
