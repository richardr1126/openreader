'use client';

import { Button } from '@headlessui/react';
import Link from 'next/link';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { useRouter } from 'next/navigation';
import { UserIcon } from '@/components/icons/Icons';

type UserMenuVariant = 'toolbar' | 'sidebar';

export function UserMenu({
  className = '',
  variant = 'toolbar',
}: {
  className?: string;
  variant?: UserMenuVariant;
}) {
  const { authEnabled, baseUrl } = useAuthConfig();
  const enableUserSignups = useFeatureFlag('enableUserSignups');
  const { data: session, isPending } = useAuthSession();
  const router = useRouter();

  if (!authEnabled || isPending) return null;

  const handleDisconnectAccount = async () => {
    const client = getAuthClient(baseUrl);
    await client.signOut();
    router.push('/signin');
  };

  const rowClass =
    'w-full inline-flex items-center gap-2 px-2 py-1 rounded-md text-[12px] border border-transparent transition-all duration-200 ease-out text-left hover:scale-[1.01] hover:border-accent hover:bg-offbase hover:text-accent';

  if (!session || session.user.isAnonymous) {
    if (variant === 'sidebar') {
      return (
        <div className={`flex w-full flex-col gap-0.5 ${className}`}>
          <Link href="/signin" className={rowClass}>
            <UserIcon className="h-3.5 w-3.5 text-muted" />
            <span className="truncate">Connect</span>
          </Link>
          {enableUserSignups && (
            <Link href="/signup" className={rowClass}>
              <UserIcon className="h-3.5 w-3.5 text-muted" />
              <span className="truncate">Create account</span>
            </Link>
          )}
        </div>
      );
    }

    return (
      <div className={`flex gap-2 ${className}`}>
        <Link href="/signin">
          <Button className="inline-flex items-center rounded-md bg-base border border-offbase px-2 py-1 text-xs font-medium text-foreground hover:bg-offbase focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 transform transition-all duration-200 ease-in-out hover:scale-[1.01] hover:text-accent">
            Connect
          </Button>
        </Link>
        {enableUserSignups && (
          <Link href="/signup">
            <Button className="inline-flex items-center rounded-md bg-accent px-2 py-1 text-xs font-medium text-background hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 transform transition-all duration-200 ease-in-out hover:scale-[1.01]">
              Create account
            </Button>
          </Link>
        )}
      </div>
    );
  }

  if (variant === 'sidebar') {
    return (
      <button
        onClick={handleDisconnectAccount}
        className={`${rowClass} ${className}`}
        title="Disconnect account"
      >
        <UserIcon className="h-3.5 w-3.5 text-muted" />
        <span className="truncate flex-1">{session.user.email || 'Account'}</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
      </button>
    );
  }

  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded-md border border-offbase bg-base ${className}`}>
      <span className="hidden sm:block text-xs font-medium text-foreground truncate max-w-[160px]">
        {session.user.email || 'Account'}
      </span>

      <Button
        onClick={handleDisconnectAccount}
        className="inline-flex items-center text-foreground text-xs hover:text-accent transform transition-all duration-200 ease-in-out hover:scale-[1.01]"
        title="Disconnect account"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
      </Button>
    </div>
  );
}
