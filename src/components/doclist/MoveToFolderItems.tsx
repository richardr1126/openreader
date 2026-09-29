'use client';

import type { DocumentListDocument, Folder } from '@/types/documents';
import { MenuActionItem } from '@/components/ui';
import { FolderIcon, FolderPlusIcon } from './window/finderIcons';

/**
 * Menu rows for filing documents into a folder. Shared by the per-document
 * actions menu and the floating selection bar so both offer the same moves.
 */
export function MoveToFolderItems({
  docs,
  folders,
  onMove,
  onNewFolder,
}: {
  docs: DocumentListDocument[];
  folders: Folder[];
  onMove: (docs: DocumentListDocument[], folderId: string | null) => void;
  onNewFolder: (docs: DocumentListDocument[]) => void;
}) {
  const inFolder = docs.some((doc) => doc.folderId);
  return (
    <>
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Move to</div>
      <div className="max-h-44 overflow-y-auto">
        {folders.map((folder) => (
          <MenuActionItem
            key={folder.id}
            disabled={docs.every((doc) => doc.folderId === folder.id)}
            onClick={() => onMove(docs, folder.id)}
          >
            <FolderIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{folder.name}</span>
          </MenuActionItem>
        ))}
      </div>
      <MenuActionItem onClick={() => onNewFolder(docs)}>
        <FolderPlusIcon className="h-4 w-4 shrink-0" />
        New folder…
      </MenuActionItem>
      {inFolder && (
        <MenuActionItem onClick={() => onMove(docs, null)}>
          <span className="h-4 w-4 shrink-0" aria-hidden="true" />
          Remove from folder
        </MenuActionItem>
      )}
    </>
  );
}
