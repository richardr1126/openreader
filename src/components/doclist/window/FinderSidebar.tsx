'use client';

import { Menu, MenuButton, MenuItem, MenuItems, Transition } from '@headlessui/react';
import { Fragment, useRef, type CSSProperties, type ReactNode } from 'react';
import { useDrop } from 'react-dnd';
import type { Folder, SidebarFilter } from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon, DotsHorizontalIcon } from '@/components/icons/Icons';
import { FolderIcon, HomeIcon, ClockIcon, FolderPlusIcon } from './finderIcons';
import { DND_DOCUMENT, type DocumentDragItem } from '../dnd/dndTypes';

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

interface SidebarRowProps {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
  countClassName?: string;
  trailing?: ReactNode;
  isDropTarget?: boolean;
}

function SidebarRow({
  active,
  onClick,
  icon,
  label,
  count,
  countClassName,
  trailing,
  isDropTarget,
}: SidebarRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'group w-full flex items-center gap-2 px-2 py-1 rounded-md text-[12px] border transform transition-all duration-200 ease-out text-left hover:scale-[1.01] ' +
        (active
          ? 'border-accent bg-offbase text-accent'
          : 'border-transparent bg-transparent text-foreground hover:border-accent hover:text-accent') +
        (isDropTarget ? ' ring-1 ring-accent' : '')
      }
    >
      <span
        className={
          'w-4 h-4 shrink-0 flex items-center justify-center transition-colors duration-200 ' +
          (active ? 'text-accent' : 'text-muted group-hover:text-accent')
        }
      >
        {icon}
      </span>
      <span className="truncate flex-1">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span
          className={`text-[10px] text-muted tabular-nums transition-transform duration-200 ease-out ${countClassName ?? ''}`}
        >
          {count}
        </span>
      )}
      {trailing}
    </button>
  );
}

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
      <SidebarRow
        active={active}
        onClick={onClick}
        icon={<FolderIcon className="w-3.5 h-3.5" />}
        label={folder.name}
        count={folder.documents.length}
        countClassName="group-hover/folder:-translate-x-6 group-focus-within/folder:-translate-x-6"
        isDropTarget={isDropTarget}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded text-muted opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 hover:text-accent hover:bg-offbase transition"
        aria-label={`Delete ${folder.name}`}
        title={`Delete ${folder.name}`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function SectionHeader({
  children,
  isFirst,
  rightSlot,
}: {
  children: ReactNode;
  isFirst?: boolean;
  rightSlot?: ReactNode;
}) {
  return (
    <div
      className={
        'px-2 pb-1 text-[10px] uppercase tracking-[0.08em] text-muted font-semibold leading-none flex items-center justify-between ' +
        (isFirst ? 'pt-1.5' : 'pt-3')
      }
    >
      <span>{children}</span>
      {rightSlot && <span className="inline-flex items-center leading-none shrink-0">{rightSlot}</span>}
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
    <aside
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
      className="relative h-full w-full md:[width:var(--sidebar-width)] bg-base border-r border-offbase shrink-0 flex flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-2 flex flex-col gap-0.5">
          {topSlot && (
            <div className="mb-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
              {topSlot}
            </div>
          )}
          <SectionHeader isFirst={!!topSlot}>Library</SectionHeader>
          <SidebarRow
            active={filter === 'all'}
            onClick={() => {
              onFilterChange('all');
              onRowAction?.();
            }}
            icon={<HomeIcon className="w-3.5 h-3.5" />}
            label="All Documents"
            count={counts.all}
          />
          <SidebarRow
            active={filter === 'recents'}
            onClick={() => {
              onFilterChange('recents');
              onRowAction?.();
            }}
            icon={<ClockIcon className="w-3.5 h-3.5" />}
            label="Recently Opened"
          />

          <SectionHeader>Kinds</SectionHeader>
          <SidebarRow
            active={filter === 'pdf'}
            onClick={() => {
              onFilterChange('pdf');
              onRowAction?.();
            }}
            icon={<PDFIcon className="w-3.5 h-3.5" />}
            label="PDF"
            count={counts.pdf}
          />
          <SidebarRow
            active={filter === 'epub'}
            onClick={() => {
              onFilterChange('epub');
              onRowAction?.();
            }}
            icon={<EPUBIcon className="w-3.5 h-3.5" />}
            label="EPUB"
            count={counts.epub}
          />
          <SidebarRow
            active={filter === 'html'}
            onClick={() => {
              onFilterChange('html');
              onRowAction?.();
            }}
            icon={<FileIcon className="w-3.5 h-3.5" />}
            label="Text"
            count={counts.html}
          />

          <SectionHeader
            rightSlot={(
              <Menu as="div" className="relative inline-flex items-center leading-none text-left shrink-0 normal-case tracking-normal font-normal">
                <MenuButton
                  className="inline-flex items-center justify-center h-3.5 w-5 rounded-sm text-muted hover:text-accent transition-colors duration-200 ease-out focus:outline-none"
                  title="Folder actions"
                  aria-label="Folder actions"
                >
                  <DotsHorizontalIcon className="w-4 h-2.5" />
                </MenuButton>
                <Transition
                  as={Fragment}
                  enter="transition ease-out duration-100"
                  enterFrom="transform opacity-0 scale-95"
                  enterTo="transform opacity-100 scale-100"
                  leave="transition ease-in duration-75"
                  leaveFrom="transform opacity-100 scale-100"
                  leaveTo="transform opacity-0 scale-95"
                >
                  <MenuItems
                    anchor="bottom start"
                    className="z-50 mt-2 min-w-[180px] rounded-md bg-base shadow-lg ring-1 ring-black/5 focus:outline-none p-1 normal-case tracking-normal font-normal"
                  >
                    <MenuItem>
                      {({ active }) => (
                        <button
                          type="button"
                          onClick={() => {
                            onNewFolder();
                            onRowAction?.();
                          }}
                          className={`${active ? 'bg-offbase text-accent' : 'text-foreground'} group flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs`}
                        >
                          <FolderPlusIcon className="h-4 w-4" />
                          New Folder
                        </button>
                      )}
                    </MenuItem>
                    <MenuItem disabled={folders.length === 0}>
                      {({ active, disabled }) => (
                        <button
                          type="button"
                          onClick={() => {
                            onClearFolders();
                            onRowAction?.();
                          }}
                          disabled={disabled}
                          className={`${disabled ? 'text-muted/60 cursor-not-allowed' : active ? 'bg-offbase text-accent' : 'text-foreground'} group flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs`}
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          Remove All Folders
                        </button>
                      )}
                    </MenuItem>
                  </MenuItems>
                </Transition>
              </Menu>
            )}
          >
            Folders
          </SectionHeader>
          {folders.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-muted">No folders yet</p>
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
        </div>
      </div>
      {bottomSlot && (
        <div className="shrink-0 border-t border-offbase p-2" onClick={(e) => e.stopPropagation()}>
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
        className="hidden md:block absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-offbase active:bg-accent transition-colors duration-200 ease-out"
      />
    </aside>
  );
}
