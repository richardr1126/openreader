/**
 * Shared client-side API request + error parsing.
 *
 * Phase 1 foundation for the data-storage refactor: every client API call used
 * to inline the same `if (!res.ok) { json().catch(...); throw new Error(...) }`
 * dance. This centralizes that so failures carry a status code and a parsed
 * server message, and React Query hooks can surface real errors instead of
 * translating them into empty defaults.
 */

export class ApiError extends Error {
  readonly status: number;
  /** Parsed JSON body when the server returned one, otherwise null. */
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
  }
  return fallback;
}

/**
 * Build an {@link ApiError} from a failed response, reading a JSON `{ error }`
 * or `{ message }` body when present. Never throws while parsing.
 */
export async function parseApiError(res: Response, fallback: string): Promise<ApiError> {
  let body: unknown = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    body = await res.json().catch(() => null);
  }
  return new ApiError(messageFromBody(body, `${fallback} (status ${res.status})`), res.status, body);
}

/**
 * Fetch and parse a JSON response, throwing an {@link ApiError} with the
 * server's message on any non-2xx status.
 */
export async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallback: string,
): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    throw await parseApiError(res, fallback);
  }
  return (await res.json()) as T;
}
