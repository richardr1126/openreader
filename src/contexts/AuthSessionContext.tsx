'use client';

import { createContext, useMemo, useState, type ReactNode } from 'react';
import { getAuthClient } from '@/lib/client/auth-client';

type LiveSession = ReturnType<ReturnType<typeof getAuthClient>['useSession']>;
type LiveSessionData = NonNullable<LiveSession['data']>;

/** What the browser may hold: the session token stays out of server-rendered HTML. */
export interface AuthSessionData {
  user: Omit<LiveSessionData['user'], 'isAnonymous'> & { isAnonymous?: boolean | null };
  session: Pick<LiveSessionData['session'], 'id' | 'userId' | 'expiresAt'>;
}

export type AuthSessionValue = Omit<LiveSession, 'data'> & { data: AuthSessionData | null };

export const AuthSessionContext = createContext<AuthSessionValue | null>(null);

export function AuthSessionProvider({
  children,
  authBaseUrl,
  initialSession,
}: {
  children: ReactNode;
  authBaseUrl: string | null;
  initialSession: AuthSessionData | null;
}) {
  const client = useMemo(() => getAuthClient(authBaseUrl), [authBaseUrl]);
  const live = client.useSession();

  // The server's answer only stands in until the first client fetch settles.
  // A later refetch with no data reports pending again, and reusing the seed
  // then would bring back the user from before a sign-out.
  const [settled, setSettled] = useState(false);
  if (!settled && !live.isPending && !live.error) setSettled(true);

  const value = settled || !initialSession
    ? live
    : { ...live, data: initialSession, isPending: false };

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}
