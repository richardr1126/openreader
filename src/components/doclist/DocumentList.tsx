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
import { SidebarUploadStatus } from './SidebarUploadStatus';
import { GalleryView } from './views/GalleryView';
import { IconsView } from './views/IconsView';
import { ListView } from './views/ListView';
import { FinderSidebar } from './window/FinderSidebar';
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
    iosBetaBannerDismissed,
    viewMode,
    iconSize,
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
          itemCount={model.visibleDocuments.length}
          totalSize={model.visibleBytes}
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
              folderId={controller.activeFolderId}
              onClick={controller.openUploadDialog}
            />
          )}
          bottomSlot={(
            <div className="flex flex-col gap-2">
              {controller.uploadSummary && (
                <SidebarUploadStatus
                  summary={controller.uploadSummary}
                  onCancel={controller.cancelUploads}
                  onRetry={controller.retryFailedUploads}
                  onDismiss={controller.dismissUploadStatus}
                />
              )}
              {appActions}
            </div>
          )}
          onRowAction={controller.closeMobileSidebar}
        />
      }
      sidebarOpen={controller.effectiveSidebarOpen}
      onRequestSidebarClose={controller.closeMobileSidebar}
    >
      {!initialLoading && !queryError && !iosBetaBannerDismissed && (
        <div className="px-3 pt-3 shrink-0 bg-surface-sunken">
          <aside
            aria-label="OpenReader for iOS beta"
            className="relative flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-accent-line bg-surface py-2.5 pl-3 pr-11 shadow-elev-1"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent-line bg-accent-wash text-accent" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
                <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
                <path d="M10.5 18.5h3" strokeLinecap="round" />
              </svg>
            </span>
            <div className="min-w-[180px] flex-1">
              <p className="text-sm font-semibold leading-tight text-foreground">OpenReader for iOS is coming soon</p>
              <p className="mt-0.5 text-xs leading-snug text-soft">On-device reading and Kokoro speech with Apple&rsquo;s Core AI.</p>
            </div>
            <a
              href="https://testflight.apple.com/join/eJTYjDwV"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-accent-line bg-accent-wash px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Join iOS beta <span aria-hidden="true">↗</span>
            </a>
            <IconButton
              onClick={() => controller.updateListState({ iosBetaBannerDismissed: true }, true)}
              size="sm"
              className="absolute right-2 top-2"
              aria-label="Dismiss iOS beta banner"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
              </svg>
            </IconButton>
          </aside>
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
            folderId={controller.activeFolderId}
          />
        </div>
      ) : (
        <DocumentUploader
          variant="overlay"
          className="flex-1 min-h-0 flex flex-col"
          folderId={controller.activeFolderId}
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
        folderId={controller.activeFolderId}
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
