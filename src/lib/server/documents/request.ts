import { after, type NextRequest, NextResponse } from 'next/server';
import { resolveApiPrincipal, type ApiPrincipal, type ApiScope } from '@/lib/server/api/principal';
import { ApiRequestError, apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import type { ComputeLimitSubject } from '@/lib/server/compute-limits/policy';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { isS3Configured } from '@/lib/server/storage/s3';
import { createRequestLogger } from '@/lib/server/logger';
import { isMissingBlobError } from './blobstore';
import { UploadFolderError } from './finalize-upload';

export type DocumentCaller = {
  principal: ApiPrincipal;
  subject: ComputeLimitSubject;
  schedule: typeof after;
};

/** JSON control messages, including text imports, stay below Vercel's body cap. */
export async function documentBody(request: NextRequest): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 3 * 1024 * 1024) throw new ApiRequestError(413, 'REQUEST_TOO_LARGE', 'Document requests are limited to 3 MB.');
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

export async function documentApi(request: NextRequest, scope: ApiScope, run: (caller: DocumentCaller) => Promise<Response>): Promise<Response> {
  const { logger } = createRequestLogger({ route: request.nextUrl.pathname, request });
  try {
    const principal = await resolveApiPrincipal(request, scope);
    if (principal instanceof Response) return principal;
    if (!isS3Configured()) return apiErrorResponse(503, 'OBJECT_STORAGE_REQUIRED', 'Document storage is unavailable.');
    const device = principal.isAnonymous ? getOrCreateDeviceId(request) : null;
    const response = await run({ principal, schedule: after, subject: {
      userId: principal.userId, isAnonymous: principal.isAnonymous, ip: getClientIp(request), deviceId: device?.deviceId,
    } });
    if (device?.didCreate && response instanceof NextResponse) setDeviceIdCookie(response, device.deviceId);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof UploadFolderError) return apiErrorResponse(error.status, 'FOLDER_INVALID', error.message);
    if (isMissingBlobError(error)) return apiErrorResponse(404, 'UPLOAD_NOT_FOUND', 'Upload not found or expired.');
    return apiCatchResponse(error, { logger, event: 'documents.request_failed', msg: 'Document request failed.', normalize: { code: 'DOCUMENT_REQUEST_FAILED', errorClass: 'storage' } });
  }
}
