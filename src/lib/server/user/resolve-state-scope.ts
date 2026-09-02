import type { NextRequest } from 'next/server';
import type { AuthContext } from '@/lib/server/auth/auth';
import { requireAuthContext } from '@/lib/server/auth/auth';

export type ResolvedUserStateScope = {
  auth: AuthContext;
  ownerUserId: string;
};

export async function resolveUserStateScope(
  req: NextRequest,
): Promise<ResolvedUserStateScope | Response> {
  const auth = await requireAuthContext(req);
  if (auth instanceof Response) return auth;
  if (!auth.userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const ownerUserId = auth.userId;

  return {
    auth,
    ownerUserId,
  };
}
