import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { isAuthEnabled } from '@/lib/server/auth/config';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { deleteUserStorageData } from '@/lib/server/user/data-cleanup';
import { errorToLog, hashForLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export async function DELETE() {
  if (!isAuthEnabled() || !auth) {
    return NextResponse.json({ error: 'Authentication disabled' }, { status: 403 });
  }

  const reqHeaders = await headers();

  const session = await auth.api.getSession({
    headers: reqHeaders
  });

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Best-effort cleanup for test namespaced storage using request context.
    // The Better Auth beforeDelete hook still runs and handles non-namespaced data.
    const testNamespace = getOpenReaderTestNamespace(reqHeaders);
    if (testNamespace) {
      try {
        await deleteUserStorageData(session.user.id, testNamespace);
      } catch (error) {
        serverLogger.warn({
          event: 'account.delete.storage_cleanup_failed',
          degraded: true,
          step: 'namespaced_storage_cleanup',
          userIdHash: hashForLog(session.user.id),
          error: errorToLog(error),
        }, 'Failed to clean up namespaced user storage before deletion');
      }
    }

    // Use Better Auth's built-in deleteUser to handle cascading cleanup
    await auth.api.deleteUser({
      headers: reqHeaders,
      body: {},
    });

    return NextResponse.json({ success: true });
  } catch (error) {
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
