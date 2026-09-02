'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DownloadIcon } from '@/components/icons/Icons';
import { Button, ChoiceTile } from '@/components/ui';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAccountExport } from './useAccountExport';

export function AccountSettingsPanel() {
  const runtimeConfig = useRuntimeConfig();
  const { baseUrl: authBaseUrl } = useAuthConfig();
  const { data: session } = useAuthSession();
  const router = useRouter();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { isExporting, startExport } = useAccountExport();

  const handleSignOut = async () => {
    const client = getAuthClient(authBaseUrl);
    await client.signOut();
    router.push('/signin');
  };

  const handleDeleteAccount = async () => {
    try {
      const response = await fetch('/api/account/delete', { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete account');

      const client = getAuthClient(authBaseUrl);
      await client.signOut();
      window.location.href = runtimeConfig.enableUserSignups ? '/signup' : '/signin';
    } catch (error) {
      console.error('Failed to delete account:', error);
    }
    setShowDeleteConfirm(false);
  };

  return (
    <>
      <div className="space-y-2">
        <div className="rounded-lg bg-background border border-line p-4 space-y-2">
          <h4 className="text-sm font-medium text-foreground">Current Session</h4>
          <div className="text-sm space-y-1">
            <p className="text-soft">Logged in as:</p>
            {session?.user ? (
              <>
                <p className="font-medium text-foreground">
                  {session.user.isAnonymous
                    ? 'Anonymous'
                    : (session.user.name || session.user.email || 'Account')}
                </p>
                {!session.user.isAnonymous && (
                  <p className="text-xs text-soft font-mono">{session.user.email}</p>
                )}
                {session.user.isAnonymous && (
                  <p className="text-xs text-accent mt-1">Anonymous session</p>
                )}
              </>
            ) : (
              <p className="font-medium text-foreground">No active session</p>
            )}
          </div>
        </div>

        {session?.user && (
          <ChoiceTile
            onClick={startExport}
            disabled={isExporting}
            className="w-full rounded-lg bg-background p-4 text-left hover:bg-accent-wash"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-surface-sunken flex items-center justify-center">
              <DownloadIcon className="w-5 h-5 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Export My Data</p>
              <p className="text-xs text-soft">
                {isExporting ? 'Preparing your ZIP export...' : 'Download all your data as a ZIP file'}
              </p>
            </div>
          </ChoiceTile>
        )}

        <div className="space-y-2">
          {session?.user && !session.user.isAnonymous ? (
            <>
              <Button onClick={handleSignOut} variant="outline" size="md">
                Disconnect account
              </Button>

              <div className="pt-4 mt-4 border-t border-line-soft">
                <label className="block text-sm font-medium text-danger mb-2">Danger Zone</label>
                <Button
                  onClick={() => setShowDeleteConfirm(true)}
                  variant="danger"
                  size="md"
                >
                  Delete Account
                </Button>
                <p className="text-xs text-soft mt-2">
                  Permanently deletes your account and all data.
                </p>
              </div>
            </>
          ) : (
            <div className="pt-2 border-t border-line-soft">
              <p className="text-sm text-soft mb-3">
                {session?.user?.isAnonymous
                  ? (runtimeConfig.enableUserSignups
                    ? 'You are using an anonymous session. Sign up to save your progress permanently, your current data is automatically transferred.'
                    : 'You are using an anonymous session. New account sign-ups are currently disabled by the site administrator.')
                  : (runtimeConfig.enableUserSignups
                    ? 'No active session. Please sign in or create an account.'
                    : 'No active session. Please sign in.')}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href="/signin">
                  <Button variant="outline" size="md">Connect</Button>
                </Link>
                {runtimeConfig.enableUserSignups && (
                  <Link href="/signup">
                    <Button variant="primary" size="md">Create account</Button>
                  </Link>
                )}
                <Link href="/?redirect=false">
                  <Button variant="outline" size="md">Back to landing page</Button>
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteAccount}
        title="Delete Account"
        message="Are you sure you want to delete your account? This action cannot be undone and all your data will be lost."
        confirmText="Delete Account"
        isDangerous
      />
    </>
  );
}
