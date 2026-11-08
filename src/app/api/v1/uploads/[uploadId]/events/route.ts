import { NextRequest } from 'next/server';
import { ApiRequestError } from '@/lib/server/api/responses';
import { documentApi } from '@/lib/server/documents/request';
import { authorizeUploadOperation, uploadId } from '@/lib/server/documents/uploads';
import { proxyOperationEvents } from '@/lib/server/compute-worker/operation-events-proxy';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export function GET(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  return documentApi(request, 'documents:read', async caller => {
    const id = uploadId((await context.params).uploadId);
    const opId = request.nextUrl.searchParams.get('opId')?.trim();
    if (!opId) throw new ApiRequestError(400, 'REQUEST_INVALID', 'opId is required.');
    if (!await authorizeUploadOperation(caller, id, opId)) throw new ApiRequestError(403, 'OPERATION_FORBIDDEN', 'Operation does not belong to this upload.');
    return proxyOperationEvents({ request, opId, streamErrorMessage: 'Failed to observe document conversion.' });
  });
}
