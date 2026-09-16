'use client';

import Link from 'next/link';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { useRouter } from 'next/navigation';
import { UserIcon } from '@/components/icons/Icons';
import { ButtonLink, IconButton, SidebarNavLink } from '@/components/ui';

type UserMenuVariant = 'toolbar' | 'sidebar';

export function UserMenu({
  className = '',
  variant = 'toolbar',
}: {
  className?: string;
  variant?: UserMenuVariant;
}) {
  const { baseUrl } = useAuthConfig();
  const { signupPolicy } = useRuntimeConfig();
  const canSignUp = signupPolicy !== 'closed';
  const { data: session, isPending } = useAuthSession();
  const router = useRouter();

  if (isPending) return null;

  const handleSignOut = async () => {
    const client = getAuthClient(baseUrl);
    await client.signOut();
    router.push('/signin');
  };

  if (!session || session.user.isAnonymous) {
    if (variant === 'sidebar') {
      return (
        <div className={`flex w-full flex-col gap-0.5 ${className}`}>
          <SidebarNavLink
            href="/signin"
            compact
            icon={<UserIcon className="h-3.5 w-3.5" />}
            label="Sign in"
          />
          {canSignUp && (
            <SidebarNavLink
              href="/signup"
              compact
              icon={<UserIcon className="h-3.5 w-3.5" />}
              label="Sign up"
            />
          )}
        </div>
      );
    }

    return (
      <div className={`flex gap-2 ${className}`}>
        <ButtonLink href="/signin" variant="secondary" size="sm">
          Sign in
        </ButtonLink>
        {canSignUp && (
          <ButtonLink href="/signup" variant="primary" size="sm">
            Sign up
          </ButtonLink>
        )}
      </div>
    );
  }

  if (variant === 'sidebar') {
    return (
      <div className={`flex min-w-0 overflow-hidden rounded-md border border-line bg-surface ${className}`}>
        <SidebarNavLink
          href="/app/settings?section=account"
          compact
          className="min-w-0 flex-1 rounded-none border-0"
          title="Account settings"
          aria-label="Open account settings"
          icon={<UserIcon className="h-3.5 w-3.5" />}
          label={session.user.email || 'Account'}
        />
        <IconButton
          onClick={handleSignOut}
          title="Sign out"
          aria-label="Sign out"
          size="xs"
          className="h-auto w-8 self-stretch rounded-none border-l border-line-soft hover:bg-danger-wash hover:text-danger"
        >
          <svg className="h-3.5 w-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            <polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line>
          </svg>
        </IconButton>
      </div>
    );
  }

  return (
    <div className={`flex h-7 min-w-0 items-stretch overflow-hidden rounded-md border border-line bg-surface ${className}`}>
      <Link
        href="/app/settings?section=account"
        title="Account settings"
        aria-label="Open account settings"
        className="group flex min-w-0 items-center gap-1.5 px-2 text-[11px] font-medium text-foreground transition-colors duration-base hover:bg-accent-wash hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <UserIcon className="h-3.5 w-3.5 shrink-0 text-soft transition-colors duration-base group-hover:text-accent" />
        <span className="hidden max-w-[150px] truncate sm:block">
          {session.user.email || 'Account'}
        </span>
      </Link>

      <IconButton
        onClick={handleSignOut}
        title="Sign out"
        aria-label="Sign out"
        size="xs"
        className="h-full w-7 rounded-none border-l border-line-soft hover:bg-danger-wash hover:text-danger"
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
