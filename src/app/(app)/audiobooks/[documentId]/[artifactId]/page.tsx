import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { AudiobookDownloadScreen } from '@/components/auth/AudiobookDownloadScreen';
import { resolveAudiobookDownload } from '@/lib/server/audiobooks/download';

export const metadata: Metadata = { title: 'Download audiobook' };

export default async function AudiobookDownloadPage({ params }: { params: Promise<{ documentId: string; artifactId: string }> }) {
  const { documentId, artifactId } = await params;
  return <AudiobookDownloadScreen download={await resolveAudiobookDownload(await headers(), documentId, artifactId)} />;
}
