'use client';

import { useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useHTML } from '@/contexts/HTMLContext';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';

interface HTMLViewerProps {
  className?: string;
}

export function HTMLViewer({ className = '' }: HTMLViewerProps) {
  const { currDocData, currDocName } = useHTML();
  const containerRef = useRef<HTMLDivElement>(null);

  if (!currDocData) {
    return <DocumentSkeleton />;
  }

  // Check if the file is a txt file
  const isTxtFile = currDocName?.toLowerCase().endsWith('.txt');

  return (
    <div className={`flex flex-col h-full ${className}`} ref={containerRef}>
      <div className="flex-1 overflow-auto">
        <div className={`html-container min-w-full px-4 py-4 ${isTxtFile ? 'whitespace-pre-wrap font-mono text-sm' : 'prose prose-base'}`}>
          {isTxtFile ? (
            currDocData
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {currDocData}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}
