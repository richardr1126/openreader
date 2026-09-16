import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import {
  AdminUserManagementError,
  deleteManagedUser,
  updateManagedUser,
  type UserAccessStatus,
} from '@/lib/server/admin/users';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

const ACCESS_STATUSES = new Set<UserAccessStatus>(['active', 'pending', 'suspended']);

function managementError(error: unknown, event: string) {
  if (error instanceof AdminUserManagementError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  serverLogger.error({ event, error: errorToLog(error) }, 'Admin user mutation failed');
  return errorResponse(error, {
    apiErrorMessage: 'Unable to update user',
    normalize: { code: 'ADMIN_USER_MUTATION_FAILED', errorClass: 'db' },
  });
}

export async function PATCH(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
) {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected JSON object' }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'isAdmin' && key !== 'accessStatus');
  if (unknown.length > 0) {
    return NextResponse.json({ error: `Unknown field: ${unknown[0]}` }, { status: 400 });
  }
  if (record.isAdmin !== undefined && typeof record.isAdmin !== 'boolean') {
    return NextResponse.json({ error: 'isAdmin must be a boolean' }, { status: 400 });
  }
  if (record.accessStatus !== undefined && !ACCESS_STATUSES.has(record.accessStatus as UserAccessStatus)) {
    return NextResponse.json({ error: 'Invalid accessStatus' }, { status: 400 });
  }
  if (record.isAdmin === undefined && record.accessStatus === undefined) {
    return NextResponse.json({ error: 'No user changes supplied' }, { status: 400 });
  }

  const { id } = await routeContext.params;
  try {
    await updateManagedUser({
      actorUserId: context.userId!,
      targetUserId: id,
      ...(record.isAdmin !== undefined ? { isAdmin: record.isAdmin as boolean } : {}),
      ...(record.accessStatus !== undefined ? { accessStatus: record.accessStatus as UserAccessStatus } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return managementError(error, 'admin.users.update.failed');
  }
}

export async function DELETE(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
) {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context;
  const { id } = await routeContext.params;
  try {
    await deleteManagedUser({ actorUserId: context.userId!, targetUserId: id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return managementError(error, 'admin.users.delete.failed');
  }
}
