import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/server/auth/auth';
import { AdminUserManagementError, markUsersForDeletion } from '@/lib/server/admin/users';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { queueUserDeletion } from '@/lib/server/tasks/enqueue-maintenance';
import { errorToLog, hashForLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export async function DELETE() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isComputeWorkerAvailable()) {
    return NextResponse.json({ error: 'Compute worker is required for account deletion' }, { status: 503 });
  }

  let marked = false;
  try {
    // Marking signs the account out and blocks access; the worker job removes
    // storage and then the rows, so this request never waits on the sweep.
    await markUsersForDeletion([session.user.id]);
    marked = true;
    await queueUserDeletion([session.user.id]);
    return NextResponse.json({ success: true }, { status: 202 });
  } catch (error) {
    if (error instanceof AdminUserManagementError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (marked) {
      // The marker is durable: Finish pending account deletions retries it.
      serverLogger.warn({
        event: 'account.delete.queue_failed',
        userIdHash: hashForLog(session.user.id),
        error: errorToLog(error),
      }, 'Account marked for deletion; queueing cleanup failed and will be retried');
      return NextResponse.json({ success: true }, { status: 202 });
    }
    serverLogger.error({
      event: 'account.delete.failed',
      error: errorToLog(error),
    }, 'Failed to delete account');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to delete account',
      normalize: { code: 'ACCOUNT_DELETE_FAILED', errorClass: 'db' },
    });
  }
}
