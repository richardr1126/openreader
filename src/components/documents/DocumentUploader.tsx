'use client';

import { useState, useCallback, useId, type ReactNode } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadIcon } from '@/components/icons/Icons';
import { useDocuments } from '@/contexts/DocumentContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { dropzoneSurfaceClass } from '@/components/ui';

interface DocumentUploaderProps {
  className?: string;
  variant?: 'default' | 'compact' | 'overlay';
  children?: ReactNode;
  onUploadBatchChange?: (state: UploadBatchState) => void;
}

export interface UploadBatchState {
  uploaderId: string;
  isActive: boolean;
  totalFiles: number;
  completedFiles: number;
  phase: 'uploading';
  currentFileName: string | null;
}

export function DocumentUploader({
  className = '',
  variant = 'default',
  children,
  onUploadBatchChange,
}: DocumentUploaderProps) {
  const uploaderId = useId();
  const enableDocx = useFeatureFlag('enableDocxConversion');
  const {
    uploadDocuments,
  } = useDocuments();
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emitBatchState = useCallback((state: Omit<UploadBatchState, 'uploaderId'>) => {
    onUploadBatchChange?.({ uploaderId, ...state });
  }, [onUploadBatchChange, uploaderId]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!acceptedFiles || acceptedFiles.length === 0) return;

    const totalFiles = acceptedFiles.length;
    let completedFiles = 0;

    setIsUploading(true);
    setError(null);
    emitBatchState({
      isActive: true,
      totalFiles,
      completedFiles,
      phase: 'uploading',
      currentFileName: acceptedFiles[0]?.name ?? null,
    });

    try {
      const uploadableFiles = acceptedFiles.filter((file) =>
        file.type === 'application/pdf'
        || file.type === 'application/epub+zip'
        || file.type === 'text/plain'
        || file.type === 'text/markdown'
        || file.name.endsWith('.md')
        || (enableDocx && file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      );

      if (uploadableFiles.length > 0) {
        await uploadDocuments(uploadableFiles);
        completedFiles = uploadableFiles.length;
      }
    } catch (err) {
      setError('Failed to upload file. Please try again.');
      console.error('Upload error:', err);
    } finally {
      setIsUploading(false);
      emitBatchState({
        isActive: false,
        totalFiles,
        completedFiles,
        phase: 'uploading',
        currentFileName: null,
      });
    }
  }, [uploadDocuments, enableDocx, emitBatchState]);

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
    disabled: isUploading,
    noClick: variant === 'overlay',
    noKeyboard: variant === 'overlay'
  });

  const isDisabled = isUploading;

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
              {error && (
                <p className="mt-3 text-sm text-danger">
                  Upload failed: {error} — try again.
                </p>
              )}
            </div>
          </div>
        )}
        {!isDragActive && error && (
          <div className="absolute inset-x-4 bottom-4 z-40 rounded-md border border-danger bg-danger-wash px-3 py-2 text-center text-sm text-danger pointer-events-none">
            Upload failed: {error} — try again.
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      {...getRootProps()}
      className={dropzoneSurfaceClass({
        variant: variant === 'compact' ? 'compact' : 'default',
        active: isDragActive,
        disabled: isDisabled,
        className,
      })}
    >
      <input {...getInputProps()} />
      {variant === 'compact' ? (
        <div className="flex items-center gap-2 text-left w-full min-w-0">
          <UploadIcon className="w-3.5 h-3.5 text-soft group-hover:text-accent shrink-0 transition-colors duration-base" />
          {isUploading ? (
            <p className="text-[12px] font-medium truncate flex-1">Uploading…</p>
          ) : (
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <p className="text-[12px] truncate flex-1">
                {isDragActive ? 'Drop files here' : 'Upload documents'}
              </p>
              {error && <p className="text-[10px] text-danger truncate shrink-0">{error}</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center text-center">
          <UploadIcon className="w-7 h-7 sm:w-10 sm:h-10 mb-2 text-soft" />
          {isUploading ? (
            <p className="text-sm sm:text-lg font-semibold text-foreground">Uploading file...</p>
          ) : (
            <>
              <p className="mb-2 text-sm sm:text-lg font-semibold text-foreground">
                {isDragActive ? 'Drop your file(s) here' : 'Drop your file(s) here, or click to select'}
              </p>
              <p className="text-xs sm:text-sm text-soft">
                {enableDocx ? 'PDF, EPUB, TXT, MD, or DOCX files are accepted' : 'PDF, EPUB, TXT, or MD files are accepted'}
              </p>
              {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
