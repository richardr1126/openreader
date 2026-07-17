'use client';

import { ReactNode, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ThemeProvider } from '@/contexts/ThemeContext';
import { AuthRateLimitProvider, type OidcAuthPublicConfig } from '@/contexts/AuthRateLimitContext';
import { RuntimeConfigProvider } from '@/contexts/RuntimeConfigContext';
import { AuthLoader } from '@/components/auth/AuthLoader';

interface ProvidersProps {
  children: ReactNode;
  authBaseUrl: string | null;
  allowAnonymousAuthSessions: boolean;
  githubAuthEnabled: boolean;
  oidcAuth: OidcAuthPublicConfig | null;
}

export function Providers({ children, authBaseUrl, allowAnonymousAuthSessions, githubAuthEnabled, oidcAuth }: ProvidersProps) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  }));

  useEffect(() => {
    // Legacy cleanup: all user state now lives in server-backed storage (see
    // the data-storage refactor). This best-effort delete removes the old
    // Dexie/RxDB `openreader-db` database left on clients that used a build
    // prior to the migration. It never blocks startup and the app is fully
    // correct without it.
    //
    // Safe to remove once we can assume no active client still carries the
    // legacy database — i.e. one full release cycle after the data-storage
    // migration ships (target: the release following v4.3.0).
    if (typeof indexedDB === 'undefined') return;
    try {
      indexedDB.deleteDatabase('openreader-db');
    } catch {
      // Best effort only; quota/private-mode failures are non-fatal.
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RuntimeConfigProvider>
        <AuthRateLimitProvider
          authBaseUrl={authBaseUrl}
          allowAnonymousAuthSessions={allowAnonymousAuthSessions}
          githubAuthEnabled={githubAuthEnabled}
          oidcAuth={oidcAuth}
        >
          <ThemeProvider>
            <AuthLoader>
              {children}
            </AuthLoader>
          </ThemeProvider>
        </AuthRateLimitProvider>
      </RuntimeConfigProvider>
    </QueryClientProvider>
  );
}
