'use client';

import { useState, useCallback, type ReactNode } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadIcon } from '@/components/icons/Icons';
import { useDocuments } from '@/contexts/DocumentContext';
import { uploadDocxAsPdf } from '@/lib/client/api/documents';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';


interface DocumentUploaderProps {
  className?: string;
  variant?: 'default' | 'compact' | 'overlay';
  children?: ReactNode;
}

export function DocumentUploader({ className = '', variant = 'default', children }: DocumentUploaderProps) {
  const enableDocx = useFeatureFlag('enableDocxConversion');
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
  }, [addHTML, addPDF, addEPUB, refreshDocuments, enableDocx]);

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
    disabled: isUploading || isConverting,
    noClick: variant === 'overlay',
    noKeyboard: variant === 'overlay'
  });

  const containerBase = `group w-full rounded transform transition-all duration-200 ease-in-out ${
    variant === 'compact' ? 'hover:scale-[1.01]' : ''
  } ${
    isUploading || isConverting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
  } ${className}`;

  const borderBgClass =
    variant === 'compact'
      ? `${
          isDragActive
            ? 'border border-accent bg-offbase text-accent'
            : 'border border-dashed border-offbase text-foreground hover:border-accent hover:bg-offbase hover:text-accent'
        }`
      : `${
          isDragActive
            ? 'border-2 border-dashed border-accent bg-base text-foreground'
            : 'border-2 border-dashed border-muted bg-transparent text-foreground hover:border-accent hover:bg-base hover:scale-[1.008]'
        }`;

  const paddingClass = variant === 'compact' ? 'py-1 px-2 rounded-md' : 'py-5 px-3 rounded-lg';

  if (variant === 'overlay') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { onClick, onKeyDown, ...rootProps } = getRootProps();
    return (
      <div {...rootProps} className={`relative w-full h-full ${className}`}>
        <input {...getInputProps()} />
        {children}
        {isDragActive && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/90 backdrop-blur-md pointer-events-none p-6">
            <div className="w-full h-full border-2 border-dashed border-accent rounded-xl flex flex-col items-center justify-center bg-base/60 text-center p-4">
              <UploadIcon className="w-14 h-14 text-accent mb-4 animate-bounce" />
              <p className="text-xl font-bold text-foreground mb-1.5">
                Drop files here to upload
              </p>
              <p className="text-sm text-foreground/70">
                {enableDocx
                  ? 'Accepts PDF, EPUB, TXT, MD, or DOCX'
                  : 'Accepts PDF, EPUB, TXT, or MD'}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      {...getRootProps()}
      className={`${containerBase} ${borderBgClass} ${paddingClass}`}
    >
      <input {...getInputProps()} />
      {variant === 'compact' ? (
        <div className="flex items-center gap-2 text-left w-full min-w-0">
          <UploadIcon className="w-3.5 h-3.5 text-muted group-hover:text-accent shrink-0 transition-colors duration-200" />
          {isUploading ? (
            <p className="text-[12px] font-medium truncate flex-1">Uploading…</p>
          ) : isConverting ? (
            <p className="text-[12px] font-medium truncate flex-1">Converting DOCX…</p>
          ) : (
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <p className="text-[12px] truncate flex-1">
                {isDragActive ? 'Drop files here' : 'Upload documents'}
              </p>
              {error && <p className="text-[10px] text-red-500 truncate shrink-0">{error}</p>}
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
