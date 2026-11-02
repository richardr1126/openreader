'use client';
import Link from 'next/link';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';

export function StorageLimitMessage({ message }: { message: string }) {
  const canSignUp = useRuntimeConfig().signupPolicy !== 'closed';
  if (!message.includes('/app/settings?section=storage')) return <>{message}</>;
  return <>
    {message.split(' Free space in Storage')[0]}{' '}
    <Link href="/app/settings?section=storage" className="underline">Free space in Storage</Link>
    {canSignUp && message.includes('/signup') ? <> · <Link href="/signup" className="underline">Create an account</Link></> : null}
  </>;
}
