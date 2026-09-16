import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import {
  listAdminUsers,
  type AdminUserKindFilter,
  type AdminUserStatusFilter,
} from '@/lib/server/admin/users';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

const KINDS = new Set<AdminUserKindFilter>(['all', 'account', 'anonymous']);
const STATUSES = new Set<AdminUserStatusFilter>(['all', 'active', 'pending', 'suspended']);

export async function GET(request: NextRequest) {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context;

  const params = request.nextUrl.searchParams;
  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 25);
  const kind = params.get('kind') ?? 'all';
  const status = params.get('status') ?? 'all';
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return NextResponse.json({ error: 'Invalid pagination' }, { status: 400 });
  }
  if (!KINDS.has(kind as AdminUserKindFilter) || !STATUSES.has(status as AdminUserStatusFilter)) {
    return NextResponse.json({ error: 'Invalid filter' }, { status: 400 });
  }

  try {
    return NextResponse.json(await listAdminUsers({
      page,
      pageSize,
      search: params.get('search') ?? '',
      kind: kind as AdminUserKindFilter,
      status: status as AdminUserStatusFilter,
    }));
  } catch (error) {
    serverLogger.error({
      event: 'admin.users.list.failed',
      error: errorToLog(error),
    }, 'Admin user listing failed');
    return errorResponse(error, {
      apiErrorMessage: 'Unable to load users',
      normalize: { code: 'ADMIN_USERS_LIST_FAILED', errorClass: 'db' },
    });
  }
}
