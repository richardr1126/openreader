'use client';

import { Button } from '@headlessui/react';
import Link from 'next/link';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { useRouter } from 'next/navigation';

export function UserMenu({ className = '' }: { className?: string }) {
  const { authEnabled, baseUrl } = useAuthConfig();
  const { data: session, isPending } = useAuthSession();
  const router = useRouter();

  if (!authEnabled || isPending) return null;

  const handleDisconnectAccount = async () => {
    const client = getAuthClient(baseUrl);
    await client.signOut();
    router.push('/signin');
  };

  if (!session || session.user.isAnonymous) {
    return (
      <div className={`flex gap-2 ${className}`}>
        <Link href="/signin">
          <Button className="inline-flex items-center rounded-md bg-base border border-offbase px-2 py-1 text-xs font-medium text-foreground hover:bg-offbase focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 transform transition-all duration-200 ease-in-out hover:scale-[1.09] hover:text-accent">
            Connect
          </Button>
        </Link>
        <Link href="/signup">
          <Button className="inline-flex items-center rounded-md bg-accent px-2 py-1 text-xs font-medium text-background hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 transform transition-all duration-200 ease-in-out hover:scale-[1.09]">
            Create account
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded-md border border-offbase bg-base ${className}`}>
      <span className="hidden sm:block text-xs font-medium text-foreground truncate max-w-[160px]">
        {session.user.email || 'Account'}
      </span>

      <Button
        onClick={handleDisconnectAccount}
        className="inline-flex items-center text-foreground text-xs hover:text-accent transform transition-all duration-200 ease-in-out hover:scale-[1.09]"
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
