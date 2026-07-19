'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateFolderDialog } from '@/components/doclist/CreateFolderDialog';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { DocumentUploader } from '@/components/documents/DocumentUploader';
import { UploadMenuDialog } from '@/components/documents/UploadMenuDialog';
import { IconButton } from '@/components/ui';
import { QueryError, RefreshIndicator } from '@/components/ui/query-states';
import { DocumentDndProvider } from './dnd/DocumentDndProvider';
import { DocumentSelectionProvider } from './dnd/DocumentSelectionContext';
import { SidebarUploadLoader } from './SidebarUploadLoader';
import { GalleryView } from './views/GalleryView';
import { IconsView } from './views/IconsView';
import { ListView } from './views/ListView';
import { FinderSidebar } from './window/FinderSidebar';
import { FinderStatusBar } from './window/FinderStatusBar';
import { FinderToolbar } from './window/FinderToolbar';
import { FinderWindow } from './window/FinderWindow';
import { useDocumentListController } from './useDocumentListController';

interface DocumentListInnerProps {
  brand?: ReactNode;
  appActions?: ReactNode;
}

function DocumentListInner({ brand, appActions }: DocumentListInnerProps) {
  const controller = useDocumentListController();
  const {
    listState,
    model,
    documentsQueryState,
  } = controller;
  const {
    sortBy,
    sortDirection,
    viewMode,
    iconSize,
    showHint,
    sidebarWidth,
    sidebarFilter,
  } = listState;
  const { initialLoading, error: queryError } = documentsQueryState;

  const handleFolderDialogKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    confirm: () => void,
    cancel: () => void,
  ) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirm();
    } else if (event.key === 'Escape') {
      cancel();
    }
  };

  return (
    <FinderWindow
      toolbar={
        <FinderToolbar
          viewMode={viewMode}
          onViewModeChange={(mode) => controller.updateListState({ viewMode: mode })}
          iconSize={iconSize}
          onIconSizeChange={(size) => controller.updateListState({ iconSize: size })}
          sortBy={sortBy}
          sortDirection={sortDirection}
          onSortByChange={(by) => controller.updateListState({ sortBy: by })}
          onSortDirectionToggle={() => controller.updateListState({
            sortDirection: sortDirection === 'asc' ? 'desc' : 'asc',
          })}
          query={controller.query}
          onQueryChange={controller.setQuery}
          onToggleSidebar={controller.toggleSidebar}
          isSidebarOpen={controller.effectiveSidebarOpen}
          showSortControls={sidebarFilter !== 'recents'}
          leftSlot={brand}
        />
      }
      sidebar={
        <FinderSidebar
          filter={sidebarFilter}
          onFilterChange={(filter) => controller.updateListState({ sidebarFilter: filter })}
          folders={model.folders}
          counts={model.counts}
          onDeleteFolder={controller.deleteFolder}
          onNewFolder={controller.openManualFolderPrompt}
          onClearFolders={controller.requestClearFolders}
          onDropOnFolder={controller.dropOnFolder}
          width={sidebarWidth}
          onWidthChange={(width) => controller.updateListState({ sidebarWidth: width })}
          topSlot={(
            <DocumentUploader
              variant="compact"
              onUploadBatchChange={controller.handleUploadBatchChange}
              onClick={controller.openUploadDialog}
            />
          )}
          bottomSlot={(
            <div className="flex flex-col gap-2">
              {controller.sidebarUploadState && (
                <SidebarUploadLoader {...controller.sidebarUploadState} />
              )}
              {appActions}
            </div>
          )}
          onRowAction={controller.closeMobileSidebar}
        />
      }
      statusBar={
        <FinderStatusBar
          itemCount={model.allDocuments.length}
          selectedCount={controller.visibleSelectedCount}
          totalSize={model.totalBytes}
          summary={model.summary}
        />
      }
      sidebarOpen={controller.effectiveSidebarOpen}
      onRequestSidebarClose={controller.closeMobileSidebar}
    >
      {!initialLoading && !queryError && showHint && model.allDocuments.length > 1 && (
        <div className="px-3 pt-3 shrink-0 bg-surface-sunken">
          <div className="flex items-center justify-between bg-surface border border-line rounded-md px-3 py-1 text-[12px]">
            <p className="text-foreground">
              Drag files onto each other to make folders. Drop into the sidebar to move.
            </p>
            <IconButton
              onClick={() => controller.updateListState({ showHint: false }, true)}
              size="xs"
              className="h-6 w-6"
              aria-label="Dismiss hint"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </IconButton>
          </div>
        </div>
      )}

      {queryError ? (
        <QueryError
          error={queryError}
          onRetry={controller.retryQueries}
          className="flex-1 min-h-0 px-6"
        />
      ) : initialLoading ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <DocumentListSkeleton viewMode={viewMode} iconSize={iconSize} />
        </div>
      ) : model.allDocuments.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <DocumentUploader
            className="py-12 w-full max-w-2xl"
            onUploadBatchChange={controller.handleUploadBatchChange}
          />
        </div>
      ) : (
        <DocumentUploader
          variant="overlay"
          className="flex-1 min-h-0 flex flex-col"
          onUploadBatchChange={controller.handleUploadBatchChange}
        >
          <RefreshIndicator
            refreshing={documentsQueryState.refreshing}
            warn={Boolean(documentsQueryState.backgroundError)}
            className="pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full border border-line bg-surface-solid px-3 py-1 shadow-elev-1"
          />
          {viewMode === 'icons' && (
            <IconsView
              documents={model.visibleDocuments}
              iconSize={iconSize}
              onDeleteDoc={controller.requestDeleteDocument}
              onMergeIntoFolder={controller.requestMergeIntoFolder}
            />
          )}
          {viewMode === 'list' && (
            <ListView
              documents={model.visibleDocuments}
              sortBy={sortBy}
              sortDirection={sortDirection}
              onSortChange={(by, direction) => controller.updateListState({
                sortBy: by,
                sortDirection: direction,
              })}
              onDeleteDoc={controller.requestDeleteDocument}
              onMergeIntoFolder={controller.requestMergeIntoFolder}
            />
          )}
          {viewMode === 'gallery' && (
            <GalleryView
              documents={model.visibleDocuments}
              folderNameById={model.folderNameById}
              onDeleteDoc={controller.requestDeleteDocument}
              onMergeIntoFolder={controller.requestMergeIntoFolder}
            />
          )}
        </DocumentUploader>
      )}

      <CreateFolderDialog
        isOpen={controller.pendingMerge !== null}
        onClose={controller.cancelPendingFolder}
        folderName={controller.newFolderName}
        onFolderNameChange={controller.setNewFolderName}
        onKeyDown={(event) => handleFolderDialogKeyDown(
          event,
          () => { void controller.confirmPendingFolder(); },
          controller.cancelPendingFolder,
        )}
      />

      <CreateFolderDialog
        isOpen={controller.manualFolderPrompt}
        onClose={controller.cancelManualFolder}
        folderName={controller.newFolderName}
        onFolderNameChange={controller.setNewFolderName}
        onKeyDown={(event) => handleFolderDialogKeyDown(
          event,
          controller.confirmManualFolder,
          controller.cancelManualFolder,
        )}
      />

      <ConfirmDialog
        isOpen={controller.documentToDelete !== null}
        onClose={controller.cancelDeleteDocument}
        onConfirm={controller.confirmDeleteDocument}
        title="Delete Document"
        message={`Are you sure you want to delete ${controller.documentToDelete?.name ?? 'this document'}?`}
        confirmText="Delete"
        isDangerous
      />

      <ConfirmDialog
        isOpen={controller.clearFoldersPrompt}
        onClose={controller.cancelClearFolders}
        onConfirm={controller.confirmClearFolders}
        title="Remove All Folders"
        message="Remove all folders? This will not delete documents."
        confirmText="Remove Folders"
        isDangerous
      />

      <UploadMenuDialog
        isOpen={controller.isUploadDialogOpen}
        onClose={controller.closeUploadDialog}
        onUploadBatchChange={controller.handleUploadBatchChange}
      />
    </FinderWindow>
  );
}

export function DocumentList({
  brand,
  appActions,
}: {
  brand?: ReactNode;
  appActions?: ReactNode;
} = {}) {
  return (
    <DocumentDndProvider>
      <DocumentSelectionProvider>
        <DocumentListInner brand={brand} appActions={appActions} />
      </DocumentSelectionProvider>
    </DocumentDndProvider>
  );
}
