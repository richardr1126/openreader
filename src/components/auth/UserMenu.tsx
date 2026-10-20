'use client';

import Link from 'next/link';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { useRouter } from 'next/navigation';
import { LogoutIcon, UserIcon } from '@/components/icons/Icons';
import { ButtonLink, IconButton, SidebarNavLink, Tooltip } from '@/components/ui';

type UserMenuVariant = 'toolbar' | 'sidebar';

export function UserMenu({
  className = '',
  variant = 'toolbar',
}: {
  className?: string;
  variant?: UserMenuVariant;
}) {
  const { baseUrl } = useAuthConfig();
  const { signupPolicy, installProfile } = useRuntimeConfig();
  const canSignUp = signupPolicy !== 'closed';
  const { data: session, isPending } = useAuthSession();
  const router = useRouter();

  // Desktop has one owner: the shell would sign straight back in, the address is
  // a placeholder, and Settings already lists Profile, so there is no menu.
  if (isPending || installProfile === 'desktop') return null;

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

  const accountLabel = session.user.email || 'Account';

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
          label={accountLabel}
        />
        <Tooltip label="Sign out">
          <IconButton
            onClick={handleSignOut}
            aria-label="Sign out"
            size="xs"
            className="h-auto w-8 self-stretch rounded-none border-l border-line-soft hover:bg-danger-wash hover:text-danger"
          >
            <LogoutIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </IconButton>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={`flex h-7 min-w-0 items-stretch overflow-hidden rounded-md border border-line bg-surface ${className}`}>
      <Tooltip label="Account settings">
      <Link
        href="/app/settings?section=account"
        aria-label="Open account settings"
        className="group flex min-w-0 items-center gap-1.5 px-2 text-[11px] font-medium text-foreground transition-colors duration-base hover:bg-accent-wash hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <UserIcon className="h-3.5 w-3.5 shrink-0 text-soft transition-colors duration-base group-hover:text-accent" />
        <span className="hidden max-w-[150px] truncate sm:block">
          {accountLabel}
        </span>
      </Link>
      </Tooltip>

      <Tooltip label="Sign out">
        <IconButton
          onClick={handleSignOut}
          aria-label="Sign out"
          size="xs"
          className="h-full w-7 rounded-none border-l border-line-soft hover:bg-danger-wash hover:text-danger"
        >
          <LogoutIcon className="h-3.5 w-3.5" aria-hidden />
        </IconButton>
      </Tooltip>
    </div>
  );
}
