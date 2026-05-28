'use client';

import { Header } from '@/components/Header';
import { DocumentUploader } from '@/components/documents/DocumentUploader';
import { DocumentList } from '@/components/doclist/DocumentList';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { SettingsModal } from '@/components/SettingsModal';
import { UserMenu } from '@/components/auth/UserMenu';
import { useDocuments } from '@/contexts/DocumentContext';

const Brand = () => (
  <div className="flex items-center gap-2 min-w-0">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/icon.svg" alt="" className="w-5 h-5 shrink-0" aria-hidden="true" />
    <h1 className="hidden sm:block text-xs sm:text-sm font-bold truncate text-foreground tracking-tight">
      OpenReader
    </h1>
  </div>
);

const AppActions = () => (
  <>
    <SettingsModal />
    <UserMenu />
  </>
);

export function HomeContent() {
  const { pdfDocs, epubDocs, htmlDocs, isPDFLoading } = useDocuments();
  const totalDocs = (pdfDocs?.length || 0) + (epubDocs?.length || 0) + (htmlDocs?.length || 0);

  if (isPDFLoading) {
    return (
      <div className="w-full h-full flex flex-col">
        <Header title={<Brand />} right={<AppActions />} />
        <div className="flex-1 min-h-0 p-3 overflow-auto">
          <DocumentListSkeleton />
        </div>
      </div>
    );
  }

  if (totalDocs === 0) {
    return (
      <div className="w-full h-full flex flex-col">
        <Header title={<Brand />} right={<AppActions />} />
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <DocumentUploader className="py-12 w-full max-w-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <DocumentList brand={<Brand />} appActions={<AppActions />} />
    </div>
  );
}
