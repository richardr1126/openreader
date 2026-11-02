'use client';

import Link from 'next/link';
import { STORAGE_LIMIT_MESSAGES } from '@openreader/runtime-config/compute-limit-broker';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';

const STORAGE_LIMIT_TEXT = new Set<string>(Object.values(STORAGE_LIMIT_MESSAGES));

/** Shows an error as written, adding the ways out when it is a storage cap. */
export function StorageLimitMessage({ message }: { message: string }) {
  const canSignUp = useRuntimeConfig().signupPolicy !== 'closed';
  const { data: session } = useAuthSession();
  if (!STORAGE_LIMIT_TEXT.has(message)) return <>{message}</>;
  return <>
    {message}{' '}
    <Link href="/app/settings?section=storage" className="underline">Free space in Storage</Link>
    {canSignUp && session?.user?.isAnonymous ? <> · <Link href="/signup" className="underline">Create an account</Link></> : null}
  </>;
}
