'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button, ButtonLink } from '@/components/ui';
import { AuthCard } from '@/components/auth/AuthCard';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { getAuthClient } from '@/lib/client/auth-client';
import { signInPathFor } from '@/lib/shared/sign-in-return';

/**
 * A link this session can't open. A missing item and another account's look the same,
 * so guests sign in and an account goes back to its library or switches account.
 */
export function AccessRequiredCard({ subject, accountName }: { subject: 'audiobook' | 'document'; accountName: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { baseUrl } = useAuthConfig();
  // The desktop app has one owner, so there is no other account to switch to.
  const { installProfile } = useRuntimeConfig();
  const [error, setError] = useState<string | null>(null);
  const signIn = signInPathFor(pathname);

  async function switchAccount() {
    setError(null);
    const { error } = await getAuthClient(baseUrl).signOut();
    if (error) setError(error.message || 'Unable to sign out.');
    else router.push(signIn);
  }

  if (!accountName) {
    return <AuthCard title={subject === 'audiobook' ? 'Sign in to download this audiobook' : 'Sign in to open this document'}>
      <ButtonLink href={signIn} variant="primary" className="w-full">Sign in</ButtonLink>
    </AuthCard>;
  }
  return <AuthCard title={`Can’t open this ${subject}`} description={`It was deleted, or ${accountName} doesn’t have access.`}>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <ButtonLink href="/app" variant="primary" className="w-full">Back to library</ButtonLink>
    {installProfile !== 'desktop' && <Button variant="secondary" className="w-full" onClick={() => void switchAccount()}>Switch account</Button>}
  </AuthCard>;
}
