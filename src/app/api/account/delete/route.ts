import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/server/auth/auth';
import { AdminUserManagementError } from '@/lib/server/admin/users';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export async function DELETE() {
  const auth = await getAuth();
  const reqHeaders = await headers();

  const session = await auth.api.getSession({
    headers: reqHeaders
  });

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Use Better Auth's built-in deleteUser to handle cascading cleanup
    await auth.api.deleteUser({
      headers: reqHeaders,
      body: {},
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AdminUserManagementError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
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
