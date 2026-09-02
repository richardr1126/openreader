'use client';

import { DocumentSelectionModal } from '@/components/documents/DocumentSelectionModal';
import { ProgressPopup } from '@/components/ProgressPopup';
import { Button } from '@/components/ui';
import { useDocuments } from '@/contexts/DocumentContext';
import { clearDocumentCache } from '@/lib/client/cache/documents';
import {
  clearAllDocumentPreviewCaches,
  clearInMemoryDocumentPreviewCache,
} from '@/lib/client/cache/previews';
import { useLibraryImport } from './useLibraryImport';

const sectionShellClass = 'space-y-2 pb-3 border-b border-line-soft px-0.5';
const sectionHeadingClass = 'text-sm font-semibold text-foreground';

export function DocumentSettingsPanel() {
  const { refreshDocuments } = useDocuments();
  const libraryImport = useLibraryImport();

  const handleRefresh = async () => {
    try {
      clearInMemoryDocumentPreviewCache();
      await refreshDocuments();
    } catch (error) {
      console.error('Failed to refresh documents:', error);
    }
  };

  const handleClearCache = async () => {
    try {
      await Promise.all([clearDocumentCache(), clearAllDocumentPreviewCaches()]);
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  };

  return (
    <>
      <div className="space-y-5">
        <div className={sectionShellClass}>
          <h4 className={sectionHeadingClass}>Server Library</h4>
          <Button
            onClick={libraryImport.openSelection}
            disabled={libraryImport.isImporting}
            variant="outline"
            size="md"
          >
            {libraryImport.isImporting
              ? `Importing... ${Math.round(libraryImport.progress)}%`
              : 'Import from library'}
          </Button>
        </div>

        <div className={sectionShellClass}>
          <h4 className={sectionHeadingClass}>Cache & Data</h4>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleRefresh}
              disabled={libraryImport.isImporting}
              variant="outline"
              size="md"
            >
              Refresh
            </Button>
            <Button
              onClick={handleClearCache}
              disabled={libraryImport.isImporting}
              variant="outline"
              size="md"
            >
              Clear cache
            </Button>
          </div>
        </div>
      </div>

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
        title="Import from Library"
        confirmLabel="Import"
        isProcessing={false}
        defaultSelected={false}
        files={libraryImport.documents}
        isLoading={libraryImport.isLoading}
        errorMessage={libraryImport.errorMessage}
      />
    </>
  );
}
