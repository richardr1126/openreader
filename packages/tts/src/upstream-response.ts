function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getUpstreamStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.status === 'number') return error.status;
  if (typeof error.statusCode === 'number') return error.statusCode;
  const response = isRecord(error.response) ? error.response : undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}

function readRetryAfterHeader(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const response = isRecord(error.response) ? error.response : undefined;
  if (!response) return undefined;

  const headers = response.headers;
  if (isRecord(headers) && typeof headers.get === 'function') {
    const value = headers.get('retry-after');
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  if (isRecord(headers)) {
    const lowerCaseValue = headers['retry-after'];
    if (typeof lowerCaseValue === 'string' && lowerCaseValue.length > 0) {
      return lowerCaseValue;
    }
    const canonicalValue = headers['Retry-After'];
    if (typeof canonicalValue === 'string' && canonicalValue.length > 0) {
      return canonicalValue;
    }
  }

  return undefined;
}

export function getUpstreamRetryAfterSeconds(error: unknown): number | undefined {
  const retryAfterHeader = readRetryAfterHeader(error);
  if (!retryAfterHeader) return undefined;

  const parsed = Number(retryAfterHeader);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  const parsedDateMs = Date.parse(retryAfterHeader);
  if (!Number.isFinite(parsedDateMs)) return undefined;
  const seconds = (parsedDateMs - Date.now()) / 1000;
  if (seconds <= 0) return undefined;
  return Math.ceil(seconds);
}
