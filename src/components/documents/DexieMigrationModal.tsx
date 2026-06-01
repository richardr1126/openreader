'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild, Button } from '@headlessui/react';
import { getAllEpubDocuments, getAllHtmlDocuments, getAllPdfDocuments, updateAppConfig } from '@/lib/client/dexie';
import { listDocuments, mimeTypeForDoc, uploadDocuments } from '@/lib/client/api/documents';
import { useDocuments } from '@/contexts/DocumentContext';
import type { BaseDocument } from '@/types/documents';
import { cacheStoredDocumentFromBytes } from '@/lib/client/cache/documents';

type DexieMigrationModalProps = {
  isOpen: boolean;
  localCount: number;
  missingCount: number;
  onComplete: () => void;
};

export function DexieMigrationModal({
  isOpen,
  localCount,
  missingCount,
  onComplete,
}: DexieMigrationModalProps) {
  const { refreshDocuments } = useDocuments();
  const [displayMissingCount, setDisplayMissingCount] = useState(missingCount);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string>('');

  const closeDisabled = isUploading;

  useEffect(() => {
    setDisplayMissingCount(missingCount);
  }, [missingCount, isOpen]);

  const loadLocalDexieDocs = useCallback(async (): Promise<{
    docs: BaseDocument[];
    pdfById: Map<string, { id: string; name: string; size: number; lastModified: number; data: ArrayBuffer }>;
    epubById: Map<string, { id: string; name: string; size: number; lastModified: number; data: ArrayBuffer }>;
    htmlById: Map<string, { id: string; name: string; size: number; lastModified: number; data: string }>;
  }> => {
    const [pdfs, epubs, htmls] = await Promise.all([getAllPdfDocuments(), getAllEpubDocuments(), getAllHtmlDocuments()]);
    const docs: BaseDocument[] = [
      ...pdfs.map((d) => ({ id: d.id, name: d.name, size: d.size, lastModified: d.lastModified, type: 'pdf' as const })),
      ...epubs.map((d) => ({ id: d.id, name: d.name, size: d.size, lastModified: d.lastModified, type: 'epub' as const })),
      ...htmls.map((d) => ({ id: d.id, name: d.name, size: d.size, lastModified: d.lastModified, type: 'html' as const })),
    ];
    const pdfById = new Map(pdfs.map((d) => [d.id, d] as const));
    const epubById = new Map(epubs.map((d) => [d.id, d] as const));
    const htmlById = new Map(htmls.map((d) => [d.id, d] as const));
    return { docs, pdfById, epubById, htmlById };
  }, []);

  const title = 'Upload your local documents?';

  const handleSkip = useCallback(async () => {
    await updateAppConfig({ documentsMigrationPrompted: true });
    onComplete();
  }, [onComplete]);

  const handleUpload = useCallback(async () => {
    setIsUploading(true);
    setProgress(0);
    setStatus('Preparing upload...');

    try {
      const { docs, pdfById, epubById, htmlById } = await loadLocalDexieDocs();

      const serverDocs = await listDocuments().catch(() => null);
      const serverIds = serverDocs ? new Set(serverDocs.map((d) => d.id)) : null;
      const toUpload = serverIds ? docs.filter((d) => !serverIds.has(d.id)) : docs;
      setDisplayMissingCount(toUpload.length);

      const encoder = new TextEncoder();
      for (let i = 0; i < toUpload.length; i++) {
        const doc = toUpload[i];
        setStatus(`Uploading ${i + 1}/${toUpload.length}: ${doc.name}`);
        setProgress((i / Math.max(1, toUpload.length)) * 100);

        // Pull raw data from Dexie for this doc
        if (doc.type === 'pdf') {
          const full = pdfById.get(doc.id) ?? null;
          if (!full) continue;
          const bytes = full.data.slice(0);
          const file = new File([full.data], full.name, {
            type: mimeTypeForDoc(doc),
            lastModified: full.lastModified,
          });
          const uploaded = await uploadDocuments([file]);
          const stored = uploaded[0] ?? null;
          if (stored) {
            await cacheStoredDocumentFromBytes(stored, bytes).catch(() => { });
          }
        } else if (doc.type === 'epub') {
          const full = epubById.get(doc.id) ?? null;
          if (!full) continue;
          const bytes = full.data.slice(0);
          const file = new File([full.data], full.name, {
            type: mimeTypeForDoc(doc),
            lastModified: full.lastModified,
          });
          const uploaded = await uploadDocuments([file]);
          const stored = uploaded[0] ?? null;
          if (stored) {
            await cacheStoredDocumentFromBytes(stored, bytes).catch(() => { });
          }
        } else {
          const full = htmlById.get(doc.id) ?? null;
          if (!full) continue;
          const bytes = encoder.encode(full.data).buffer;
          const file = new File([full.data], full.name, {
            type: mimeTypeForDoc(doc),
            lastModified: full.lastModified,
          });
          const uploaded = await uploadDocuments([file]);
          const stored = uploaded[0] ?? null;
          if (stored) {
            await cacheStoredDocumentFromBytes(stored, bytes).catch(() => { });
          }
        }
      }

      setProgress(100);
      setStatus('Refreshing...');
      await refreshDocuments();
      await updateAppConfig({ documentsMigrationPrompted: true });
      onComplete();
    } catch (err) {
      console.error('Dexie migration upload failed:', err);
      setStatus('Upload failed. You can retry or skip.');
    } finally {
      setIsUploading(false);
    }
  }, [loadLocalDexieDocs, onComplete, refreshDocuments]);

  if (!isOpen) return null;

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[80]" onClose={() => (closeDisabled ? null : onComplete())}>
        <TransitionChild
          as={Fragment}
          enter="ease-standard duration-slow"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-standard duration-base"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 overlay-dim backdrop-blur-sm" />
        </TransitionChild>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-start justify-center p-4 pt-6 text-center sm:items-center sm:pt-4">
            <TransitionChild
              as={Fragment}
              enter="ease-standard duration-slow"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-standard duration-base"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel data-testid="migration-modal" className="w-full max-w-md transform rounded-2xl bg-base p-6 text-left align-middle shadow-xl transition">
                <DialogTitle as="h3" className="text-lg font-semibold leading-6 text-foreground mb-4">
                  {title}
                </DialogTitle>
                <div className="space-y-2">
                  <p className="text-sm text-muted mb-2">
                    Found {localCount} document{localCount === 1 ? '' : 's'} stored locally from an older version.
                    {displayMissingCount > 0 ? (
                      <> {displayMissingCount} {displayMissingCount === 1 ? 'is' : 'are'} not here yet.</>
                    ) : null}
                    {' '}This app now stores documents on the server and keeps a local cache for speed.
                  </p>
                  {isUploading && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted">{status}</p>
                      <div className="h-2 w-full rounded bg-offbase">
                        <div className="h-2 rounded bg-accent" style={{ width: `${Math.max(1, Math.round(progress))}%` }} />
                      </div>
                    </div>
                  )}
                  {!isUploading && status ? <p className="text-xs text-red-500">{status}</p> : null}
                </div>

                <div className="flex justify-end gap-3 mt-6">
                  <Button
                    data-testid="migration-skip-button"
                    onClick={handleSkip}
                    disabled={isUploading}
                    className="inline-flex justify-center rounded-lg bg-background px-3 py-1.5 text-sm 
                             font-medium text-foreground hover:bg-offbase focus:outline-none 
                             focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                             transform transition-transform duration-base ease-standard hover:text-accent
                             disabled:opacity-50"
                  >
                    Skip
                  </Button>
                  <Button
                    onClick={handleUpload}
                    disabled={isUploading}
                    className="inline-flex justify-center rounded-lg bg-accent px-3 py-1.5 text-sm 
                             font-medium text-background hover:bg-secondary-accent focus:outline-none 
                             focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                             transform transition-transform duration-base ease-standard hover:text-background
                             disabled:opacity-50"
                  >
                    {isUploading ? 'Uploading…' : 'Upload'}
                  </Button>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
