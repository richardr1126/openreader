'use client';

import { Menu, MenuButton, Transition } from '@headlessui/react';
import { Fragment, useRef, type CSSProperties, type ReactNode } from 'react';
import { useDrop } from 'react-dnd';
import type { Folder, SidebarFilter } from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon, DotsHorizontalIcon } from '@/components/icons/Icons';
import { FolderIcon, HomeIcon, ClockIcon, FolderPlusIcon } from './finderIcons';
import { DND_DOCUMENT, type DocumentDragItem } from '../dnd/dndTypes';
import { IconButton, MenuActionItem, MenuItemsSurface, Sidebar as SidebarShell, SidebarNav, SidebarNavGroup, SidebarNavItem } from '@/components/ui';

interface FinderSidebarProps {
  filter: SidebarFilter;
  onFilterChange: (filter: SidebarFilter) => void;
  folders: Folder[];
  counts: { all: number; pdf: number; epub: number; html: number };
  onDeleteFolder: (folderId: string) => void;
  onNewFolder: () => void;
  onClearFolders: () => void;
  /** When dragging onto a folder row, move dropped docs into that folder. */
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
  /** Width controls (desktop only). */
  width: number;
  onWidthChange: (px: number) => void;
  topSlot?: ReactNode;
  bottomSlot?: ReactNode;
  /** Fired for explicit row/button actions (used to close mobile drawer). */
  onRowAction?: () => void;
}

const MIN_WIDTH = 168;
const MAX_WIDTH = 320;

function FolderRow({
  folder,
  active,
  onClick,
  onDelete,
  onDropOnFolder,
}: {
  folder: Folder;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
}) {
  const [{ isOver, canDrop }, dropRef] = useDrop<
    DocumentDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >(() => ({
    accept: DND_DOCUMENT,
    drop: (item) => {
      onDropOnFolder(folder.id, item);
    },
    canDrop: (item) => {
      // Don't accept if all items are already in this folder.
      return item.docs.some((d) => d.folderId !== folder.id);
    },
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
  }), [folder.id, onDropOnFolder]);

  const isDropTarget = isOver && canDrop;
  return (
    <div
      ref={dropRef as unknown as React.RefObject<HTMLDivElement>}
      className="group/folder relative"
    >
      <SidebarNavItem
        compact
        active={active}
        onClick={onClick}
        icon={<FolderIcon className="w-3.5 h-3.5" />}
        label={folder.name}
        count={folder.documents.length}
        countClassName="group-hover/folder:-translate-x-6 group-focus-within/folder:-translate-x-6"
        isDropTarget={isDropTarget}
      />
      <IconButton
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        size="xs"
        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100"
        aria-label={`Delete ${folder.name}`}
        title={`Delete ${folder.name}`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </IconButton>
    </div>
  );
}

export function FinderSidebar({
  filter,
  onFilterChange,
  folders,
  counts,
  onDeleteFolder,
  onNewFolder,
  onClearFolders,
  onDropOnFolder,
  width,
  onWidthChange,
  topSlot,
  bottomSlot,
  onRowAction,
}: FinderSidebarProps) {
  const startRef = useRef<{ x: number; w: number } | null>(null);

  const onResizeStart = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, w: width };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!startRef.current) return;
    const delta = e.clientX - startRef.current.x;
    const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startRef.current.w + delta));
    onWidthChange(next);
  };
  const onResizeEnd = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    startRef.current = null;
  };

  return (
    <SidebarShell
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
      className="relative h-full w-full md:[width:var(--sidebar-width)] rounded-none border-y-0 border-l-0 border-r border-line-soft shadow-none shrink-0 flex flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav className="p-2">
          {topSlot && (
            <div className="mb-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
              {topSlot}
            </div>
          )}
          <SidebarNavGroup isFirst={!!topSlot}>Library</SidebarNavGroup>
          <SidebarNavItem
            compact
            active={filter === 'all'}
            onClick={() => {
              onFilterChange('all');
              onRowAction?.();
            }}
            icon={<HomeIcon className="w-3.5 h-3.5" />}
            label="All Documents"
            count={counts.all}
          />
          <SidebarNavItem
            compact
            active={filter === 'recents'}
            onClick={() => {
              onFilterChange('recents');
              onRowAction?.();
            }}
            icon={<ClockIcon className="w-3.5 h-3.5" />}
            label="Recently Opened"
          />

          <SidebarNavGroup>Kinds</SidebarNavGroup>
          <SidebarNavItem
            compact
            active={filter === 'pdf'}
            onClick={() => {
              onFilterChange('pdf');
              onRowAction?.();
            }}
            icon={<PDFIcon className="w-3.5 h-3.5" />}
            label="PDF"
            count={counts.pdf}
          />
          <SidebarNavItem
            compact
            active={filter === 'epub'}
            onClick={() => {
              onFilterChange('epub');
              onRowAction?.();
            }}
            icon={<EPUBIcon className="w-3.5 h-3.5" />}
            label="EPUB"
            count={counts.epub}
          />
          <SidebarNavItem
            compact
            active={filter === 'html'}
            onClick={() => {
              onFilterChange('html');
              onRowAction?.();
            }}
            icon={<FileIcon className="w-3.5 h-3.5" />}
            label="Text"
            count={counts.html}
          />

          <SidebarNavGroup
            action={(
              <Menu as="div" className="relative inline-flex items-center leading-none text-left shrink-0 normal-case tracking-normal font-normal">
                <MenuButton
                  as={IconButton}
                  size="xs"
                  className="h-3.5 w-5"
                  title="Folder actions"
                  aria-label="Folder actions"
                >
                  <DotsHorizontalIcon className="w-4 h-2.5" />
                </MenuButton>
                <Transition
                  as={Fragment}
                  enter="transition ease-standard duration-fast"
                  enterFrom="transform opacity-0 scale-95"
                  enterTo="transform opacity-100 scale-100"
                  leave="transition ease-standard duration-fast"
                  leaveFrom="transform opacity-100 scale-100"
                  leaveTo="transform opacity-0 scale-95"
                >
                  <MenuItemsSurface
                    anchor="bottom start"
                    className="z-50 mt-2 min-w-[180px] focus:outline-none normal-case tracking-normal font-normal"
                  >
                    <MenuActionItem
                      onClick={() => {
                        onNewFolder();
                        onRowAction?.();
                      }}
                    >
                      <FolderPlusIcon className="h-4 w-4" />
                      New Folder
                    </MenuActionItem>
                    <MenuActionItem
                      disabled={folders.length === 0}
                      onClick={() => {
                        onClearFolders();
                        onRowAction?.();
                      }}
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      Remove All Folders
                    </MenuActionItem>
                  </MenuItemsSurface>
                </Transition>
              </Menu>
            )}
          >
            Folders
          </SidebarNavGroup>
          {folders.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-soft">No folders yet</p>
          ) : (
            folders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                active={filter === `folder:${folder.id}`}
                onClick={() => {
                  onFilterChange(`folder:${folder.id}`);
                  onRowAction?.();
                }}
                onDelete={() => {
                  onDeleteFolder(folder.id);
                  onRowAction?.();
                }}
                onDropOnFolder={onDropOnFolder}
              />
            ))
          )}
        </SidebarNav>
      </div>
      {bottomSlot && (
        <div
          className="shrink-0 border-t border-line-soft px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:pb-2"
          onClick={(e) => e.stopPropagation()}
        >
          {bottomSlot}
        </div>
      )}

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="hidden md:block absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-accent-wash active:bg-accent transition-colors duration-base ease-standard"
      />
    </SidebarShell>
  );
}
