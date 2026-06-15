'use client';

import { ReactNode, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ThemeProvider } from '@/contexts/ThemeContext';
import { AuthRateLimitProvider } from '@/contexts/AuthRateLimitContext';
import { RuntimeConfigProvider } from '@/contexts/RuntimeConfigContext';
import { AuthLoader } from '@/components/auth/AuthLoader';

interface ProvidersProps {
  children: ReactNode;
  authBaseUrl: string | null;
  allowAnonymousAuthSessions: boolean;
  githubAuthEnabled: boolean;
}

export function Providers({ children, authBaseUrl, allowAnonymousAuthSessions, githubAuthEnabled }: ProvidersProps) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  }));

  useEffect(() => {
    if (typeof indexedDB === 'undefined') return;
    try {
      indexedDB.deleteDatabase('openreader-db');
    } catch {
      // Legacy IndexedDB cleanup is best effort and never blocks startup.
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RuntimeConfigProvider>
        <AuthRateLimitProvider
          authBaseUrl={authBaseUrl}
          allowAnonymousAuthSessions={allowAnonymousAuthSessions}
          githubAuthEnabled={githubAuthEnabled}
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
