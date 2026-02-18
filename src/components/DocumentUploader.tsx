'use client';

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadIcon } from '@/components/icons/Icons';
import { useDocuments } from '@/contexts/DocumentContext';
import { uploadDocxAsPdf } from '@/lib/client-documents';

const enableDocx = process.env.NEXT_PUBLIC_ENABLE_DOCX_CONVERSION !== 'false';


interface DocumentUploaderProps {
  className?: string;
  variant?: 'default' | 'compact';
}

export function DocumentUploader({ className = '', variant = 'default' }: DocumentUploaderProps) {
  const {
    addPDFDocument: addPDF,
    addEPUBDocument: addEPUB,
    addHTMLDocument: addHTML,
    refreshDocuments,
  } = useDocuments();
  const [isUploading, setIsUploading] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!acceptedFiles || acceptedFiles.length === 0) return;

    setIsUploading(true);
    setError(null);

    try {
      for (const file of acceptedFiles) {
        if (file.type === 'application/pdf') {
          await addPDF(file);
        } else if (file.type === 'application/epub+zip') {
          await addEPUB(file);
        } else if (file.type === 'text/plain' || file.type === 'text/markdown' || file.name.endsWith('.md')) {
          await addHTML(file);
        } else if (enableDocx && file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          // Preserve prior UX: show "Converting DOCX..." state rather than generic uploading.
          setIsUploading(false);
          setIsConverting(true);
          // Convert+upload directly on the server. Use sha(docx) as stable ID to avoid duplicates.
          await uploadDocxAsPdf(file);
          await refreshDocuments();
          setIsConverting(false);
          setIsUploading(true);
        }
      }
    } catch (err) {
      setError('Failed to upload file. Please try again.');
      console.error('Upload error:', err);
    } finally {
      setIsUploading(false);
      setIsConverting(false);
    }
  }, [addHTML, addPDF, addEPUB, refreshDocuments]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/epub+zip': ['.epub'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
      ...(enableDocx ? {
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
      } : {})
    },
    multiple: true,
    disabled: isUploading || isConverting
  });

  const containerBase = `w-full border-2 border-dashed rounded-lg ${isDragActive ? 'border-accent bg-base' : 'border-muted'} transform transition-transform duration-200 ease-in-out ${(isUploading || isConverting) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-accent hover:bg-base hover:scale-[1.008]'} ${className}`;
  const paddingClass = variant === 'compact' ? 'py-1.5 px-2' : 'py-5 px-3';

  return (
    <div
      {...getRootProps()}
      className={`${containerBase} ${paddingClass}`}
    >
      <input {...getInputProps()} />
      {variant === 'compact' ? (
        <div className="flex items-center gap-2 text-left">
          <UploadIcon className="w-5 h-5 text-muted" />
          {isUploading ? (
            <p className="text-xs font-medium text-foreground">Uploading…</p>
          ) : isConverting ? (
            <p className="text-xs font-medium text-foreground">Converting DOCX…</p>
          ) : (
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium text-foreground">
                {isDragActive ? 'Drop files here' : 'Drop files or click'}
              </p>
              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center text-center">
          <UploadIcon className="w-7 h-7 sm:w-10 sm:h-10 mb-2 text-muted" />
          {isUploading ? (
            <p className="text-sm sm:text-lg font-semibold text-foreground">Uploading file...</p>
          ) : isConverting ? (
            <p className="text-sm sm:text-lg font-semibold text-foreground">Converting DOCX to PDF...</p>
          ) : (
            <>
              <p className="mb-2 text-sm sm:text-lg font-semibold text-foreground">
                {isDragActive ? 'Drop your file(s) here' : 'Drop your file(s) here, or click to select'}
              </p>
              <p className="text-xs sm:text-sm text-muted">
                {enableDocx ? 'PDF, EPUB, TXT, MD, or DOCX files are accepted' : 'PDF, EPUB, TXT, or MD files are accepted'}
              </p>
              {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
