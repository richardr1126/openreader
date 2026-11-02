import { after, type NextRequest } from 'next/server';
import { resolveApiPrincipal, type ApiPrincipal, type ApiScope } from '@/lib/server/api/principal';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import type { ComputeLimitSubject } from '@/lib/server/compute-limits/policy';
import { isS3Configured } from '@/lib/server/storage/s3';
import { createRequestLogger } from '@/lib/server/logger';
import { isMissingBlobError } from './blobstore';
import { UploadFolderError } from './finalize-upload';

export type DocumentCaller = {
  principal: ApiPrincipal;
  subject: ComputeLimitSubject;
  schedule: typeof after;
};

export async function documentApi(request: NextRequest, scope: ApiScope, run: (caller: DocumentCaller) => Promise<Response>): Promise<Response> {
  const { logger } = createRequestLogger({ route: request.nextUrl.pathname, request });
  try {
    const principal = await resolveApiPrincipal(request, scope);
    if (principal instanceof Response) return principal;
    if (!isS3Configured()) return apiErrorResponse(503, 'OBJECT_STORAGE_REQUIRED', 'Document storage is unavailable.');

    const response = await run({ principal, schedule: after, subject: {
      userId: principal.userId, isAnonymous: principal.isAnonymous,
    } });
    // An event stream keeps its own no-transform header, which proxies need.
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof UploadFolderError) return apiErrorResponse(error.status, 'FOLDER_INVALID', error.message);
    if (isMissingBlobError(error)) return apiErrorResponse(404, 'UPLOAD_NOT_FOUND', 'Upload not found or expired.');
    return apiCatchResponse(error, { logger, event: 'documents.request_failed', msg: 'Document request failed.', normalize: { code: 'DOCUMENT_REQUEST_FAILED', errorClass: 'storage' } });
  }
}
