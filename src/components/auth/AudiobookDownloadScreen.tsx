'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button, ButtonLink } from '@/components/ui';
import { AuthCard } from '@/components/auth/AuthCard';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { triggerDownload } from '@/hooks/audio/useAudiobookExport';
import { getAuthClient } from '@/lib/client/auth-client';
import type { AudiobookDownload } from '@/types/tts-export';

export function AudiobookDownloadScreen({ download }: { download: AudiobookDownload }) {
  const pathname = usePathname();
  const router = useRouter();
  const { baseUrl } = useAuthConfig();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const signIn = `/signin?returnTo=${encodeURIComponent(pathname)}`;

  useEffect(() => {
    if (download.access !== 'ready' || started.current) return;
    started.current = true;
    triggerDownload({ url: download.fileUrl, filename: download.filename });
  }, [download]);

  async function switchAccount() {
    setError(null);
    const { error } = await getAuthClient(baseUrl).signOut();
    if (error) setError(error.message || 'Unable to sign out.');
    else router.push(signIn);
  }

  if (download.access === 'sign-in') {
    return <AuthCard title="Sign in to download this audiobook">
      <ButtonLink href={signIn} variant="primary" className="w-full">Sign in</ButtonLink>
    </AuthCard>;
  }
  if (download.access === 'denied') {
    return <AuthCard title="You need access" description={`${download.accountName} can’t open this audiobook.`}>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button variant="primary" className="w-full" onClick={() => void switchAccount()}>Switch account</Button>
    </AuthCard>;
  }
  if (download.access === 'missing') {
    return <AuthCard title="This audiobook isn’t available" description="You can make it again from the document.">
      <ButtonLink href={download.webPath} variant="primary" className="w-full">Open document</ButtonLink>
    </AuthCard>;
  }
  return <AuthCard title="Your download has started" description={<span className="break-words">{download.filename}</span>}>
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button variant="primary" className="w-full" onClick={() => triggerDownload({ url: download.fileUrl, filename: download.filename })}>Download again</Button>
      <ButtonLink href={download.webPath} className="w-full">Open document</ButtonLink>
    </div>
  </AuthCard>;
}
