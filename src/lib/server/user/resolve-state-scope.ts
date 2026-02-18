import type { NextRequest } from 'next/server';
import type { AuthContext } from '@/lib/server/auth/auth';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';

export type ResolvedUserStateScope = {
  auth: AuthContext;
  namespace: string | null;
  ownerUserId: string;
  unclaimedUserId: string;
};

export async function resolveUserStateScope(
  req: NextRequest,
): Promise<ResolvedUserStateScope | Response> {
  const auth = await requireAuthContext(req);
  if (auth instanceof Response) return auth;

  const namespace = getOpenReaderTestNamespace(req.headers);
  const unclaimedUserId = getUnclaimedUserIdForNamespace(namespace);
  const ownerUserId = auth.userId ?? unclaimedUserId;

  return {
    auth,
    namespace,
    ownerUserId,
    unclaimedUserId,
  };
}

