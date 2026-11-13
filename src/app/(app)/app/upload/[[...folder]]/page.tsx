import { notFound } from 'next/navigation';
import { LibraryPage } from '@/components/LibraryPage';

/** A link an assistant gives the user to add a file from their device, optionally into a folder. */
export default async function UploadPage({ params }: { params: Promise<{ folder?: string[] }> }) {
  const { folder = [] } = await params;
  if (folder.length > 1) notFound();
  return <LibraryPage uploadTo={{ folderId: folder[0] ?? null }} />;
}
