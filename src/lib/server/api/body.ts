import type { NextRequest } from 'next/server';
import { ApiRequestError } from './responses';

/** Bound control messages before parsing; raw file transfers have their own limit. */
export async function readApiJson(request: NextRequest, maxBytes = 3 * 1024 * 1024): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new ApiRequestError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the allowed size.');
      chunks.push(next.value);
    }
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiRequestError(400, 'REQUEST_INVALID', 'Send a JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Send a JSON object.');
  return value as Record<string, unknown>;
}
