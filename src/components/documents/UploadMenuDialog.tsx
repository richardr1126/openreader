'use client';

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useDocuments } from '@/contexts/DocumentContext';
import { importUrl } from '@/lib/client/api/documents';
import {
  SidebarDialog,
  SegmentedControl,
  Input,
  Textarea,
  Button,
} from '@/components/ui';
import {
  UploadIcon,
  DownloadIcon,
  FileIcon,
  RefreshIcon,
  BrowserIcon,
} from '@/components/icons/Icons';
import { ProgressPopup } from '@/components/ProgressPopup';
import { DocumentSelectionModal } from './DocumentSelectionModal';
import { DocumentUploader } from './DocumentUploader';
import { useLibraryImport } from './useLibraryImport';

interface UploadMenuDialogProps {
  isOpen: boolean;
  onClose: () => void;
  folderId?: string;
}

type TabValue = 'file' | 'create' | 'url' | 'library';

type SidebarSection = {
  id: TabValue;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
};

const SIDEBAR_SECTIONS: SidebarSection[] = [
  { id: 'file', label: 'Upload Files', icon: UploadIcon },
  { id: 'create', label: 'Create Document', icon: FileIcon },
  { id: 'url', label: 'Import from Web', icon: BrowserIcon },
  { id: 'library', label: 'Server Library', icon: DownloadIcon },
];

export function UploadMenuDialog({
  isOpen,
  onClose,
  folderId,
}: UploadMenuDialogProps) {
  const { uploadDocuments } = useDocuments();
  const libraryImport = useLibraryImport(folderId);
  const [activeTab, setActiveTab] = useState<TabValue>('file');

  // --- Create Text/Markdown State ---
  const [docName, setDocName] = useState('');
  const [docExtension, setDocExtension] = useState<'.md' | '.txt'>('.md');
  const [docContent, setDocContent] = useState('');
  const [isCreatingDoc, setIsCreatingDoc] = useState(false);

  // --- Import URL State ---
  const [webUrl, setWebUrl] = useState('');
  const [webTitle, setWebTitle] = useState('');
  const [importStep, setImportStep] = useState<
    'idle' | 'fetching' | 'error'
  >('idle');
  const [importError, setImportError] = useState<string | null>(null);

  const handleTabChange = useCallback((tab: TabValue) => {
    setActiveTab(tab);
    setImportError(null);
    setImportStep('idle');
  }, []);

  // --- Create Doc Action ---
  const handleCreateDocument = async () => {
    if (!docName.trim()) {
      toast.error('Please enter a document name');
      return;
    }

    setIsCreatingDoc(true);
    try {
      let filename = docName.trim();
      const ext = docExtension;
      if (!filename.toLowerCase().endsWith(ext)) {
        filename += ext;
      }

      const mimeType = ext === '.md' ? 'text/markdown' : 'text/plain';
      const file = new File([docContent], filename, { type: mimeType });

      setDocName('');
      setDocContent('');
      onClose();
      await uploadDocuments([file], { folderId });
      toast.success(`"${filename}" created successfully!`);
    } catch (err) {
      console.error('Failed to create document:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create document');
    } finally {
      setIsCreatingDoc(false);
    }
  };

  // --- Import URL Action ---
  const handleImportUrl = async () => {
    let cleanUrl = webUrl.trim();
    if (!cleanUrl) {
      toast.error('Please enter a URL');
      return;
    }

    if (!/^https?:\/\//i.test(cleanUrl)) {
      cleanUrl = 'https://' + cleanUrl;
    }

    setImportError(null);
    setImportStep('fetching');

    try {
      // Step 1: Connect and scrape content on the server
      const scrapeResult = await importUrl(cleanUrl);
      
      // Create virtual file from markdown content
      const displayTitle = webTitle.trim() || scrapeResult.title || 'Imported Web Page';
      const safeTitle = displayTitle
        .replace(/[/\\?%*:|"<>\s]+/g, '_') // collapse runs of disallowed chars
        .replace(/^_+|_+$/g, '') // trim leading/trailing underscores
        .substring(0, 80);
      const filename = `${safeTitle}.md`;
      const file = new File([scrapeResult.content], filename, {
        type: 'text/markdown',
      });

      setWebUrl('');
      setWebTitle('');
      setImportStep('idle');
      onClose();
      await uploadDocuments([file], { folderId });
      toast.success(`Successfully imported "${displayTitle}"!`);
    } catch (err) {
      console.error('Failed to import URL:', err);
      const message =
        err instanceof Error ? err.message : 'An error occurred during import';
      setImportError(message);
      setImportStep('error');
      toast.error(message);
    }
  };

  const handleClose = () => {
    // Only allow closing if not actively processing
    if (isCreatingDoc || importStep === 'fetching') {
      return;
    }
    onClose();
  };

  return (
    <>
      <SidebarDialog
        open={isOpen}
        onClose={handleClose}
        headerTitle="Add Documents"
        sections={SIDEBAR_SECTIONS}
        activeSectionId={activeTab}
        onSectionChange={handleTabChange}
        className="h-[480px]"
      >
      {/* TAB 1: File Uploader */}
      {activeTab === 'file' && (
        <div className="h-full flex flex-col gap-4 animate-fade-in">
          <p className="text-xs text-soft leading-relaxed shrink-0">
            Select files from your computer or drag and drop them anywhere. Supported formats include PDF, EPUB, TXT, and MD.
          </p>
          <DocumentUploader
            folderId={folderId}
            className="flex-1 flex flex-col justify-center border-2 border-dashed border-line rounded-lg bg-surface-sunken hover:bg-surface-solid transition-colors duration-base"
            onUploadStarted={onClose}
          />
        </div>
      )}

      {/* TAB 2: Create Custom Document */}
      {activeTab === 'create' && (
        <div className="h-full flex flex-col justify-between animate-fade-in">
          <div className="space-y-3 flex-1 flex flex-col min-h-0">
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
              <div className="flex-1">
                <Input
                  type="text"
                  value={docName}
                  onChange={(e) => setDocName(e.target.value)}
                  placeholder="Document title (e.g. notes)"
                  className="w-full font-medium"
                  controlSize="md"
                  disabled={isCreatingDoc}
                />
              </div>
              <div className="shrink-0">
                <SegmentedControl<'.md' | '.txt'>
                  ariaLabel="Document format selection"
                  value={docExtension}
                  options={[
                    { value: '.md', label: 'Markdown (.md)' },
                    { value: '.txt', label: 'Plain Text (.txt)' },
                  ]}
                  onChange={setDocExtension}
                  className="grid-cols-2"
                />
              </div>
            </div>

            <div className="flex-1 flex flex-col min-h-0">
              <Textarea
                value={docContent}
                onChange={(e) => setDocContent(e.target.value)}
                placeholder={
                  docExtension === '.md'
                    ? '# Write Markdown here\n\n- Bullet points\n- **Bold text**\n- Synchronized highlighting works automatically!'
                    : 'Type plain text document content here...'
                }
                className="flex-1 min-h-[160px] sm:min-h-[200px] font-mono text-xs p-3 leading-relaxed resize-none"
                controlSize="md"
                disabled={isCreatingDoc}
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 mt-4 shrink-0">
            <span className="text-[11px] text-soft">
              {docContent.length} character{docContent.length === 1 ? '' : 's'}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setDocName('');
                  setDocContent('');
                }}
                disabled={isCreatingDoc}
              >
                Clear
              </Button>
              <Button
                variant="primary"
                onClick={handleCreateDocument}
                disabled={isCreatingDoc}
              >
                {isCreatingDoc ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Import Web URL */}
      {activeTab === 'url' && (
        <div className="h-full flex flex-col justify-between animate-fade-in">
          <div className="space-y-4 flex-1">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="web-url" className="text-xs font-semibold text-foreground">
                  Source Web URL
                </label>
                <div className="flex gap-2">
                  <Input
                    id="web-url"
                    type="url"
                    value={webUrl}
                    onChange={(e) => setWebUrl(e.target.value)}
                    placeholder="https://en.wikipedia.org/wiki/Speed_reading"
                    className="flex-1"
                    disabled={importStep !== 'idle' && importStep !== 'error'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleImportUrl();
                      }
                    }}
                  />
                  <Button
                    variant="primary"
                    onClick={handleImportUrl}
                    disabled={importStep !== 'idle' && importStep !== 'error'}
                  >
                    Import
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="web-title" className="text-xs font-semibold text-foreground">
                  Document Title (Optional)
                </label>
                <Input
                  id="web-title"
                  type="text"
                  value={webTitle}
                  onChange={(e) => setWebTitle(e.target.value)}
                  placeholder="Leave empty to use article title"
                  className="w-full"
                  disabled={importStep !== 'idle' && importStep !== 'error'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleImportUrl();
                    }
                  }}
                />
              </div>

              <p className="text-[11px] text-soft leading-normal mt-1">
                Extracts the central article body, removes boilerplate noise (headers, sidebars, ads), and converts it into a clean Markdown document for synchrony reading.
              </p>
            </div>

            {/* Progress / Loading Stepper */}
            {importStep !== 'idle' && (
              <div className="rounded-lg border border-line bg-surface-sunken p-4 flex flex-col gap-3.5 transition-colors duration-base">
                {importStep === 'error' ? (
                  <div className="flex items-start gap-2 text-danger">
                    <svg className="h-5 w-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">Import Failed</p>
                      <p className="text-xs mt-1 text-danger-strong overflow-hidden text-ellipsis leading-relaxed">
                        {importError || 'An unknown error occurred.'}
                      </p>
                      <button
                        onClick={() => setImportStep('idle')}
                        className="text-[11px] font-medium text-accent hover:underline mt-2 flex items-center gap-1"
                      >
                        <RefreshIcon className="h-3 w-3" /> Try Again
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <RefreshIcon className="h-5 w-5 text-accent animate-spin" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">Importing Article</p>
                      <p className="text-xs text-soft">Fetching and extracting readable content…</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'library' && (
        <div className="flex h-full flex-col justify-center rounded-lg border border-line bg-surface-sunken p-6 text-center animate-fade-in">
          <DownloadIcon className="mx-auto h-8 w-8 text-accent" />
          <h3 className="mt-3 text-sm font-semibold text-foreground">Import from the server</h3>
          <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-soft">
            Browse documents exposed through this OpenReader server&apos;s mounted library folders and copy selected files into your library.
          </p>
          <Button
            variant="primary"
            className="mx-auto mt-5"
            disabled={libraryImport.isImporting}
            onClick={() => {
              onClose();
              libraryImport.openSelection();
            }}
          >
            Browse server library
          </Button>
        </div>
      )}
      </SidebarDialog>

      <ProgressPopup
        isOpen={libraryImport.showProgress}
        progress={libraryImport.progress}
        estimatedTimeRemaining={libraryImport.estimatedTimeRemaining || undefined}
        onCancel={libraryImport.cancel}
        statusMessage={libraryImport.statusMessage}
        operationType="library"
        cancelText="Cancel"
      />
      <DocumentSelectionModal
        isOpen={libraryImport.isSelectionOpen}
        onClose={libraryImport.closeSelection}
        onConfirm={libraryImport.importDocuments}
        title="Import from Server Library"
        confirmLabel="Import"
        isProcessing={libraryImport.isImporting}
        defaultSelected={false}
        files={libraryImport.documents}
        isLoading={libraryImport.isLoading}
        errorMessage={libraryImport.errorMessage}
      />
    </>
  );
}
