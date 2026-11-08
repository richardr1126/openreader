'use client';

import { useEffect, useRef } from 'react';
import { Button, ButtonLink } from '@/components/ui';
import { AccessRequiredCard } from '@/components/auth/AccessRequiredCard';
import { AuthCard } from '@/components/auth/AuthCard';
import { triggerDownload } from '@/hooks/audio/useAudiobookExport';
import type { AudiobookDownload } from '@/types/tts-export';

export function AudiobookDownloadScreen({ download }: { download: AudiobookDownload }) {
  const started = useRef(false);

  useEffect(() => {
    if (download.access !== 'ready' || started.current) return;
    started.current = true;
    triggerDownload({ url: download.fileUrl, filename: download.filename });
  }, [download]);

  if (download.access === 'sign-in') return <AccessRequiredCard subject="audiobook" accountName={null} />;
  if (download.access === 'denied') return <AccessRequiredCard subject="audiobook" accountName={download.accountName} />;
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
