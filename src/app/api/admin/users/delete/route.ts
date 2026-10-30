import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { AdminUserManagementError, requestManagedUserDeletions } from '@/lib/server/admin/users';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { queueUserDeletion } from '@/lib/server/tasks/enqueue-maintenance';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context;
  let body: { userIds?: unknown } | null;
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!Array.isArray(body?.userIds) || !body.userIds.length || body.userIds.length > 100
    || body.userIds.some((id) => typeof id !== 'string' || !id.length || id.length > 256)) {
    return NextResponse.json({ error: 'Supply between 1 and 100 user IDs' }, { status: 400 });
  }
  if (!isComputeWorkerAvailable()) return NextResponse.json({ error: 'Compute worker is required for account deletion' }, { status: 503 });
  try {
    const userIds = await requestManagedUserDeletions(context.userId!, body.userIds as string[]);
    const operation = await queueUserDeletion(userIds);
    return NextResponse.json(operation, { status: 202 });
  } catch (error) {
    if (error instanceof AdminUserManagementError) return NextResponse.json({ error: error.message }, { status: error.status });
    return errorResponse(error, {
      apiErrorMessage: 'Unable to queue deletion. Marked accounts will be retried by Finish pending account deletions.',
      normalize: { code: 'ADMIN_USER_DELETION_QUEUE_FAILED', errorClass: 'upstream' },
    });
  }
}
