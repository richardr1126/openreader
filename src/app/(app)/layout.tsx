import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Toaster } from 'react-hot-toast';

import { Providers } from '@/app/providers';
import { AppMain, AppShell } from '@/components/layout';
import { getAuthBaseUrl, isAnonymousAuthSessionsEnabled, isGithubAuthEnabled } from '@/lib/server/auth/config';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      'max-snippet': 0,
      'max-video-preview': 0,
    },
  },
};

export default function AppLayout({ children }: { children: ReactNode }) {
  const authBaseUrl = getAuthBaseUrl();
  const allowAnonymousAuthSessions = isAnonymousAuthSessionsEnabled();
  const githubAuthEnabled = isGithubAuthEnabled();

  return (
    <Providers
      authBaseUrl={authBaseUrl}
      allowAnonymousAuthSessions={allowAnonymousAuthSessions}
      githubAuthEnabled={githubAuthEnabled}
    >
      <AppShell>
        <AppMain>{children}</AppMain>
      </AppShell>
      <Toaster
        toastOptions={{
          style: {
            background: 'var(--offbase)',
            color: 'var(--foreground)',
          },
          success: {
            iconTheme: {
              primary: 'var(--accent)',
              secondary: 'var(--background)',
            },
          },
          error: {
            iconTheme: {
              primary: 'var(--accent)',
              secondary: 'var(--background)',
            },
          },
        }}
      />
    </Providers>
  );
}
