import type { NextRequest } from 'next/server';
import type { AuthContext } from '@/lib/server/auth/auth';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';

export type ResolvedUserStateScope = {
  auth: AuthContext;
  namespace: string | null;
  ownerUserId: string;
};

export async function resolveUserStateScope(
  req: NextRequest,
): Promise<ResolvedUserStateScope | Response> {
  const auth = await requireAuthContext(req);
  if (auth instanceof Response) return auth;
  if (!auth.userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const namespace = getOpenReaderTestNamespace(req.headers);
  const ownerUserId = auth.userId;

  return {
    auth,
    namespace,
    ownerUserId,
  };
}
