'use client';

import Link from 'next/link';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { useRouter } from 'next/navigation';
import { UserIcon } from '@/components/icons/Icons';
import { IconButton, buttonClass } from '@/components/ui';

type UserMenuVariant = 'toolbar' | 'sidebar';

export function UserMenu({
  className = '',
  variant = 'toolbar',
}: {
  className?: string;
  variant?: UserMenuVariant;
}) {
  const { baseUrl } = useAuthConfig();
  const enableUserSignups = useFeatureFlag('enableUserSignups');
  const { data: session, isPending } = useAuthSession();
  const router = useRouter();

  if (isPending) return null;

  const handleDisconnectAccount = async () => {
    const client = getAuthClient(baseUrl);
    await client.signOut();
    router.push('/signin');
  };

  const rowClass =
    'w-full inline-flex items-center gap-2 px-2 py-1 rounded-md text-[12px] border border-transparent transition duration-base ease-standard text-left hover:border-accent hover:bg-accent-wash hover:text-accent';

  if (!session || session.user.isAnonymous) {
    if (variant === 'sidebar') {
      return (
        <div className={`flex w-full flex-col gap-0.5 ${className}`}>
          <Link href="/signin" className={rowClass}>
            <UserIcon className="h-3.5 w-3.5 text-soft" />
            <span className="truncate">Connect</span>
          </Link>
          {enableUserSignups && (
            <Link href="/signup" className={rowClass}>
              <UserIcon className="h-3.5 w-3.5 text-soft" />
              <span className="truncate">Create account</span>
            </Link>
          )}
        </div>
      );
    }

    return (
      <div className={`flex gap-2 ${className}`}>
        <Link href="/signin">
          <span className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            Connect
          </span>
        </Link>
        {enableUserSignups && (
          <Link href="/signup">
            <span className={buttonClass({ variant: 'primary', size: 'sm' })}>
              Create account
            </span>
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
        aria-label="Disconnect account"
      >
        <UserIcon className="h-3.5 w-3.5 text-soft" />
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
    <div className={`flex items-center gap-2 px-2 py-1 rounded-md border border-line bg-surface ${className}`}>
      <span className="hidden sm:block text-xs font-medium text-foreground truncate max-w-[160px]">
        {session.user.email || 'Account'}
      </span>

      <IconButton
        onClick={handleDisconnectAccount}
        title="Disconnect account"
        aria-label="Disconnect account"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
      </IconButton>
    </div>
  );
}
