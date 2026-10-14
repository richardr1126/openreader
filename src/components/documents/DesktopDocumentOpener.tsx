'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useDocuments } from '@/contexts/DocumentContext';
import { desktopBridge } from '@/lib/client/desktop-bridge';

/**
 * Uploads documents the desktop shell opened (File → Open…, a file association,
 * the Dock) with the same flow as a drop. One opened document opens in the
 * reader; several land in the library. Renders nothing.
 */
export function DesktopDocumentOpener() {
  const { uploadDocuments } = useDocuments();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const onOpenFiles = desktopBridge()?.onOpenFiles;
    if (!onOpenFiles) return;
    return onOpenFiles((opened) => {
      const files = opened.map((file) => new File([file.bytes], file.name, { lastModified: file.lastModified }));
      uploadDocuments(files).then((documents) => {
        const [only] = documents;
        if (documents.length === 1 && only) router.push(`/${only.type}/${encodeURIComponent(only.id)}`);
        else if (pathname !== '/app') router.push('/app');
      }).catch((error: unknown) => {
        // The upload status panel shows failures; a cancel needs nothing.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Upload error:', error);
      });
    });
  }, [pathname, router, uploadDocuments]);

  return null;
}
