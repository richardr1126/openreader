'use client';

import Link from 'next/link';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { useRouter } from 'next/navigation';
import { UserIcon } from '@/components/icons/Icons';
import { ButtonLink, IconButton, SidebarNavItem, SidebarNavLink } from '@/components/ui';

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

  if (!session || session.user.isAnonymous) {
    if (variant === 'sidebar') {
      return (
        <div className={`flex w-full flex-col gap-0.5 ${className}`}>
          <Link href="/signin" legacyBehavior passHref>
            <SidebarNavLink
              compact
              icon={<UserIcon className="h-3.5 w-3.5" />}
              label="Connect"
            />
          </Link>
          {enableUserSignups && (
            <Link href="/signup" legacyBehavior passHref>
              <SidebarNavLink
                compact
                icon={<UserIcon className="h-3.5 w-3.5" />}
                label="Create account"
              />
            </Link>
          )}
        </div>
      );
    }

    return (
      <div className={`flex gap-2 ${className}`}>
        <ButtonLink href="/signin" variant="secondary" size="sm">
          Connect
        </ButtonLink>
        {enableUserSignups && (
          <ButtonLink href="/signup" variant="primary" size="sm">
            Create account
          </ButtonLink>
        )}
      </div>
    );
  }

  if (variant === 'sidebar') {
    return (
      <SidebarNavItem
        compact
        onClick={handleDisconnectAccount}
        className={className}
        title="Disconnect account"
        aria-label="Disconnect account"
        icon={<UserIcon className="h-3.5 w-3.5" />}
        label={session.user.email || 'Account'}
        trailing={(
          <svg className="h-3.5 w-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            <polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line>
          </svg>
        )}
      />
    );
  }

  return (
    <div className={`flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2 ${className}`}>
      <span className="hidden max-w-[150px] truncate text-[11px] font-medium text-foreground sm:block">
        {session.user.email || 'Account'}
      </span>

      <IconButton
        onClick={handleDisconnectAccount}
        title="Disconnect account"
        aria-label="Disconnect account"
        size="xs"
        className="-mr-0.5"
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
