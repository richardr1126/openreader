'use client';

import { DocumentUploader } from '@/components/documents/DocumentUploader';
import { DocumentList } from '@/components/doclist/DocumentList';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { useDocuments } from '@/contexts/DocumentContext';

export function HomeContent() {
  const { pdfDocs, epubDocs, htmlDocs, isPDFLoading } = useDocuments();
  const totalDocs = (pdfDocs?.length || 0) + (epubDocs?.length || 0) + (htmlDocs?.length || 0);

  if (isPDFLoading) {
    return (
      <div className="w-full">
        <DocumentListSkeleton />
      </div>
    );
  }

  if (totalDocs === 0) {
    return (
      <div className="w-full">
        <DocumentUploader className="py-12" />
      </div>
    );
  }

  return (
    <div className="w-full">
      <DocumentList />
    </div>
  );
}
