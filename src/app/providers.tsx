'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { DocumentProvider } from '@/contexts/DocumentContext';
import { PDFProvider } from '@/contexts/PDFContext';
import { EPUBProvider } from '@/contexts/EPUBContext';
import { TTSProvider } from '@/contexts/TTSContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { ConfigProvider } from '@/contexts/ConfigContext';
import { HTMLProvider } from '@/contexts/HTMLContext';
import { AuthRateLimitProvider } from '@/contexts/AuthRateLimitContext';
import { PrivacyModal } from '@/components/PrivacyModal';
import { AuthLoader } from '@/components/auth/AuthLoader';
import { DexieMigrationModal } from '@/components/documents/DexieMigrationModal';

interface ProvidersProps {
  children: ReactNode;
  authEnabled: boolean;
  authBaseUrl: string | null;
  allowAnonymousAuthSessions: boolean;
  githubAuthEnabled: boolean;
}

export function Providers({ children, authEnabled, authBaseUrl, allowAnonymousAuthSessions, githubAuthEnabled }: ProvidersProps) {
  const pathname = usePathname();
  const isAuthPage = pathname?.startsWith('/signin') || pathname?.startsWith('/signup');

  if (isAuthPage) {
    return (
      <AuthRateLimitProvider
        authEnabled={authEnabled}
        authBaseUrl={authBaseUrl}
        allowAnonymousAuthSessions={allowAnonymousAuthSessions}
        githubAuthEnabled={githubAuthEnabled}
      >
        <ThemeProvider>
          <AuthLoader>
            <>
              {children}
              <PrivacyModal authEnabled={authEnabled} />
            </>
          </AuthLoader>
        </ThemeProvider>
      </AuthRateLimitProvider>
    );
  }

  return (
    <AuthRateLimitProvider
      authEnabled={authEnabled}
      authBaseUrl={authBaseUrl}
      allowAnonymousAuthSessions={allowAnonymousAuthSessions}
      githubAuthEnabled={githubAuthEnabled}
    >
      <ThemeProvider>
        <AuthLoader>
          <ConfigProvider>
            <DocumentProvider>
              <TTSProvider>
                <PDFProvider>
                  <EPUBProvider>
                    <HTMLProvider>
                      <>
                        {children}
                        <PrivacyModal authEnabled={authEnabled} />
                        <DexieMigrationModal />
                      </>
                    </HTMLProvider>
                  </EPUBProvider>
                </PDFProvider>
              </TTSProvider>
            </DocumentProvider>
          </ConfigProvider>
        </AuthLoader>
      </ThemeProvider>
    </AuthRateLimitProvider>
  );
}
