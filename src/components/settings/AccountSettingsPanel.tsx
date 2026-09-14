'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DownloadIcon, RefreshIcon, SpeedometerIcon } from '@/components/icons/Icons';
import { Badge, Button, ChoiceTile } from '@/components/ui';
import toast from 'react-hot-toast';
import { formatCharCount, useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAccountExport } from './useAccountExport';

function TtsUsageCard() {
  const {
    status,
    loading,
    error,
    refresh,
    isAtLimit,
    timeUntilReset,
  } = useAuthRateLimit();
  const hasLimit = Boolean(
    status
    && status.enabled
    && status.limit !== null,
  );
  const limit = status?.limit ?? null;
  const usedPercent = hasLimit && status && limit !== null
    ? Math.min(100, Math.round((status.currentCount / Math.max(1, limit)) * 100))
    : 0;

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-background" aria-labelledby="tts-usage-heading">
      <div className="flex items-start gap-3 p-4">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-accent-wash text-accent">
          <SpeedometerIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 id="tts-usage-heading" className="text-sm font-medium text-foreground">TTS generation</h4>
              <p className="mt-0.5 text-xs text-soft">
                Only newly generated segments count. Replaying cached audio is always free.
              </p>
            </div>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="Refresh TTS usage"
              className="gap-1"
            >
              <RefreshIcon className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>

          {error && !status ? (
            <p className="mt-3 text-xs text-danger">Usage is temporarily unavailable.</p>
          ) : loading && !status ? (
            <div className="mt-3 h-12 animate-pulse rounded-md bg-surface-sunken" aria-label="Loading TTS usage" />
          ) : hasLimit && status && limit !== null ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="font-medium text-foreground">
                  {formatCharCount(status.currentCount)} of {formatCharCount(limit)} characters
                </span>
                <span className="text-soft">{usedPercent}%</span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-surface-sunken"
                role="progressbar"
                aria-label="Daily TTS generation usage"
                aria-valuemin={0}
                aria-valuemax={limit}
                aria-valuenow={Math.min(status.currentCount, limit)}
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-slow ${isAtLimit ? 'bg-accent' : 'bg-secondary-accent'}`}
                  style={{ width: `${usedPercent}%` }}
                />
              </div>
              <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-soft">
                <span>
                  {isAtLimit
                    ? 'New generation pauses at the next uncached segment.'
                    : `${formatCharCount(status.remainingChars ?? 0)} characters remaining.`}
                </span>
                <span>Resets in {timeUntilReset}</span>
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded-md border border-line-soft bg-surface-sunken px-3 py-2">
              <p className="text-xs font-medium text-foreground">No TTS generation limit</p>
              <p className="mt-0.5 text-xs text-soft">Your administrator is not limiting generated characters.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function AccountSettingsPanel() {
  const runtimeConfig = useRuntimeConfig();
  const { baseUrl: authBaseUrl } = useAuthConfig();
  const { data: session } = useAuthSession();
  const router = useRouter();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [resendingVerification, setResendingVerification] = useState(false);
  const { isExporting, startExport } = useAccountExport();

  const resendVerification = async () => {
    if (!session?.user?.email) return;
    setResendingVerification(true);
    try {
      const result = await getAuthClient(authBaseUrl).sendVerificationEmail({
        email: session.user.email,
        callbackURL: '/verify-email?status=success',
      });
      if (result.error) throw new Error(result.error.message);
      toast.success('Verification email queued');
    } catch {
      toast.error('Unable to resend verification email');
    } finally {
      setResendingVerification(false);
    }
  };

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
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-soft font-mono">{session.user.email}</p>
                    {runtimeConfig.accountEmailsEnabled && (
                      <Badge tone={session.user.emailVerified ? 'accent' : 'danger'}>
                        {session.user.emailVerified ? 'Verified' : 'Unverified'}
                      </Badge>
                    )}
                  </div>
                )}
                {session.user.isAnonymous && (
                  <p className="text-xs text-accent mt-1">Anonymous session</p>
                )}
              </>
            ) : (
              <p className="font-medium text-foreground">No active session</p>
            )}
          </div>
          {runtimeConfig.accountEmailsEnabled && session?.user && !session.user.isAnonymous && !session.user.emailVerified && (
            <Button variant="outline" size="sm" disabled={resendingVerification} onClick={resendVerification}>
              {resendingVerification ? 'Queuing…' : 'Resend verification email'}
            </Button>
          )}
        </div>

        {session?.user && <TtsUsageCard />}

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
                Sign out
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
                    ? 'No active session. Please sign in or sign up.'
                    : 'No active session. Please sign in.')}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href="/signin">
                  <Button variant="outline" size="md">Sign in</Button>
                </Link>
                {runtimeConfig.enableUserSignups && (
                  <Link href="/signup">
                    <Button variant="primary" size="md">Sign up</Button>
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
