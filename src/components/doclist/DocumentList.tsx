'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateFolderDialog } from '@/components/doclist/CreateFolderDialog';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { DocumentUploader } from '@/components/documents/DocumentUploader';
import { useLocalVoices } from '@/components/admin/useLocalVoices';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { UploadMenuDialog } from '@/components/documents/UploadMenuDialog';
import { QueryError, RefreshIndicator } from '@/components/ui/query-states';
import { DocumentDndProvider } from './dnd/DocumentDndProvider';
import { DocumentSelectionProvider } from './dnd/DocumentSelectionContext';
import { IosBetaBanner } from './IosBetaBanner';
import { LocalVoicesBanner } from './LocalVoicesBanner';
import { SelectionActionBar } from './SelectionActionBar';
import type { DocumentActions } from './document-actions';
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
    iosBannerDismissed,
    voicesBannerDismissed,
    viewMode,
    iconSize,
    sidebarWidth,
    sidebarFilter,
  } = listState;
  const { initialLoading, error: queryError } = documentsQueryState;
  const listReady = !initialLoading && !queryError && controller.preferencesLoaded;

  // Desktop first run: offer the on-device voices until they are downloaded.
  const { installProfile } = useRuntimeConfig();
  const { data: session } = useAuthSession();
  const isAdmin = Boolean((session?.user as { isAdmin?: boolean } | undefined)?.isAdmin);
  const offerVoices = installProfile === 'desktop' && isAdmin && controller.preferencesLoaded && !voicesBannerDismissed;
  const voices = useLocalVoices({ enabled: offerVoices });
  const showVoicesBanner = offerVoices && listReady && Boolean(voices.status) && !voices.error
    && (!voices.installed || voices.downloading);

  const actions: DocumentActions = {
    folders: model.folders,
    onDelete: controller.requestDeleteDocuments,
    onMove: controller.moveDocuments,
    onNewFolder: controller.openManualFolderPrompt,
  };

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
          statusFilter={controller.statusFilter}
          onStatusFilterChange={controller.setStatusFilter}
          onToggleSidebar={controller.toggleSidebar}
          isSidebarOpen={controller.effectiveSidebarOpen}
          showSortControls={sidebarFilter !== 'recents'}
          itemCount={model.visibleDocuments.length}
          totalSize={model.visibleBytes}
          leftSlot={brand}
        />
      }
      banner={(
        <>
          <LocalVoicesBanner
            show={showVoicesBanner}
            voices={voices}
            onDismiss={() => controller.updateListState({ voicesBannerDismissed: true }, true)}
          />
          <IosBetaBanner
            show={listReady && !showVoicesBanner && !iosBannerDismissed}
            onDismiss={() => controller.updateListState({ iosBannerDismissed: true }, true)}
          />
        </>
      )}
      sidebar={
        <FinderSidebar
          filter={sidebarFilter}
          onFilterChange={(filter) => controller.updateListState({ sidebarFilter: filter })}
          folders={model.folders}
          counts={model.counts}
          onDeleteFolder={controller.deleteFolder}
          onNewFolder={() => controller.openManualFolderPrompt()}
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
              actions={actions}
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
              actions={actions}
              onMergeIntoFolder={controller.requestMergeIntoFolder}
            />
          )}
          {viewMode === 'gallery' && (
            <GalleryView
              documents={model.visibleDocuments}
              folderNameById={model.folderNameById}
              actions={actions}
              onMergeIntoFolder={controller.requestMergeIntoFolder}
            />
          )}
          {viewMode !== 'gallery'
            && model.visibleDocuments.length === 0
            && (controller.query.trim() !== '' || controller.statusFilter !== 'any') && (
            <p className="pointer-events-none absolute inset-x-0 top-1/3 px-6 text-center text-[12px] text-soft">
              No documents match the current search or filter
            </p>
          )}
          <SelectionActionBar actions={actions} />
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
        isOpen={controller.documentsToDelete.length > 0}
        onClose={controller.cancelDeleteDocuments}
        onConfirm={controller.confirmDeleteDocuments}
        title={controller.documentsToDelete.length > 1 ? 'Delete Documents' : 'Delete Document'}
        message={
          controller.documentsToDelete.length > 1
            ? `Are you sure you want to delete these ${controller.documentsToDelete.length} documents?`
            : `Are you sure you want to delete ${controller.documentsToDelete[0]?.name ?? 'this document'}?`
        }
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
