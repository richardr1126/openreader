'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button, ButtonLink } from '@/components/ui';
import { AuthCard } from '@/components/auth/AuthCard';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { getAuthClient } from '@/lib/client/auth-client';
import { signInPathFor } from '@/lib/shared/sign-in-return';

/** A link this session can't open. Guests sign in; an account can switch to another. */
export function AccessRequiredCard({ subject, accountName }: { subject: 'audiobook' | 'document'; accountName: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { baseUrl } = useAuthConfig();
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
  return <AuthCard title="You need access" description={`${accountName} can’t open this ${subject}.`}>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Button variant="primary" className="w-full" onClick={() => void switchAccount()}>Switch account</Button>
  </AuthCard>;
}
