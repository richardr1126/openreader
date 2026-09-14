'use client';

import { useState, useCallback, type ReactNode } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { PlusIcon, UploadIcon } from '@/components/icons/Icons';
import { useDocuments } from '@/contexts/DocumentContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { dropzoneSurfaceClass } from '@/components/ui';

interface DocumentUploaderProps {
  className?: string;
  variant?: 'default' | 'compact' | 'overlay';
  children?: ReactNode;
  folderId?: string;
  onUploadStarted?: () => void;
  onClick?: () => void;
}

export function DocumentUploader({
  className = '',
  variant = 'default',
  children,
  folderId,
  onUploadStarted,
  onClick,
}: DocumentUploaderProps) {
  const enableDocx = useFeatureFlag('enableDocxConversion');
  const { uploadDocuments } = useDocuments();
  const [validationError, setValidationError] = useState<string | null>(null);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!acceptedFiles || acceptedFiles.length === 0) return;

    setValidationError(null);
    onUploadStarted?.();

    try {
      await uploadDocuments(acceptedFiles, { folderId });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Upload error:', err);
    }
  }, [folderId, onUploadStarted, uploadDocuments]);

  const onDropRejected = useCallback((rejections: FileRejection[]) => {
    if (rejections.length === 0) return;

    const supportedFormats = enableDocx
      ? 'PDF, EPUB, TXT, MD, or DOCX'
      : 'PDF, EPUB, TXT, or MD';
    const firstFileName = rejections[0]?.file.name ?? 'This file';
    const rejectedLabel = rejections.length === 1
      ? `${firstFileName} is not supported.`
      : `${rejections.length} files are not supported.`;

    setValidationError(`${rejectedLabel} Choose a ${supportedFormats} file.`);
  }, [enableDocx]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
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
    noClick: variant === 'overlay' || !!onClick,
    noKeyboard: variant === 'overlay' || !!onClick
  });

  if (variant === 'overlay') {
    const rootProps = getRootProps();
    return (
      <div {...rootProps} className={`relative w-full h-full ${className}`}>
        <input {...getInputProps()} />
        {children}
        {isDragActive && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-surface backdrop-blur-md pointer-events-none p-6">
            <div className="w-full h-full border-2 border-dashed border-accent rounded-lg flex flex-col items-center justify-center bg-surface-solid text-center p-4">
              <UploadIcon className="w-14 h-14 text-accent mb-4" />
              <p className="text-xl font-bold text-foreground mb-1.5">
                Drop files here to upload
              </p>
              <p className="text-sm text-soft">
                {enableDocx
                  ? 'Accepts PDF, EPUB, TXT, MD, or DOCX'
                  : 'Accepts PDF, EPUB, TXT, or MD'}
              </p>
              {validationError && (
                <p className="mt-3 text-sm text-danger" role="alert">
                  {validationError}
                </p>
              )}
            </div>
          </div>
        )}
        {!isDragActive && validationError && (
          <div
            className="absolute inset-x-4 bottom-4 z-40 rounded-md border border-danger bg-danger-wash px-3 py-2 text-center text-sm text-danger pointer-events-none"
            role="alert"
          >
            {validationError}
          </div>
        )}
      </div>
    );
  }

  const CompactIcon = onClick ? PlusIcon : UploadIcon;

  return (
    <div
      {...getRootProps(
        onClick
          ? {
              onClick: (e) => {
                e.stopPropagation();
                onClick();
              },
              onKeyDown: (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onClick();
              },
              role: 'button',
              tabIndex: 0,
              'aria-label': 'Add Documents',
            }
          : {}
      )}
      className={dropzoneSurfaceClass({
        variant: variant === 'compact' ? 'compact' : 'default',
        active: isDragActive,
        className,
      })}
    >
      <input {...getInputProps()} />
      {variant === 'compact' ? (
        <div className="flex items-center gap-2 text-left w-full min-w-0">
          <CompactIcon className="w-3.5 h-3.5 text-soft group-hover:text-accent shrink-0 transition-colors duration-base" />
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <p className="text-[12px] truncate flex-1">
              {isDragActive ? 'Drop files here' : onClick ? 'Add Documents' : 'Upload documents'}
            </p>
            {validationError && <p className="text-[10px] text-danger truncate shrink-0" role="alert">{validationError}</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center text-center">
          <UploadIcon className="w-7 h-7 sm:w-10 sm:h-10 mb-2 text-soft" />
          <p className="mb-2 text-sm sm:text-lg font-semibold text-foreground">
            {isDragActive ? 'Drop your file(s) here' : 'Drop your file(s) here, or click to select'}
          </p>
          <p className="text-xs sm:text-sm text-soft">
            {enableDocx ? 'PDF, EPUB, TXT, MD, or DOCX files are accepted' : 'PDF, EPUB, TXT, or MD files are accepted'}
          </p>
          {validationError && <p className="mt-2 text-sm text-danger" role="alert">{validationError}</p>}
        </div>
      )}
    </div>
  );
}
