import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { deleteUserStorageData } from '@/lib/server/user/data-cleanup';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export async function DELETE() {
  const reqHeaders = await headers();

  const session = await auth.api.getSession({
    headers: reqHeaders
  });

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Clean test-namespaced storage using request context. The Better Auth
    // beforeDelete hook handles non-namespaced storage and blocks deletion if
    // either cleanup cannot complete.
    const testNamespace = getOpenReaderTestNamespace(reqHeaders);
    if (testNamespace) {
      await deleteUserStorageData(session.user.id, testNamespace);
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
