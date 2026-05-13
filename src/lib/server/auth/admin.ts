import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuthContext, type AuthContext } from '@/lib/server/auth/auth';

export type AdminAuthContext = AuthContext & {
  user: NonNullable<AuthContext['user']> & { isAdmin: true };
};

/**
 * Returns the admin auth context, or a 401/403 Response if the requester is
 * not authenticated / not an admin. Mirrors the `requireAuthContext` shape.
 *
 * When auth is disabled, this always returns 403 — there is no notion of
 * "admin" without authentication.
 */
export async function requireAdminContext(
  request: Pick<NextRequest, 'headers'>,
): Promise<AdminAuthContext | Response> {
  const ctx = await getAuthContext(request);

  if (!ctx.authEnabled || !ctx.userId || !ctx.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // The `isAdmin` field is added via Better Auth `additionalFields`. Older
  // sessions may not carry it on the type but the DB-resolved session will.
  const userRecord = ctx.user as unknown as { isAdmin?: boolean | null };
  if (!userRecord.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return ctx as AdminAuthContext;
}
