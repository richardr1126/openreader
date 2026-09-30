'use client';

import { useEffect } from 'react';
import { useDragLayer } from 'react-dnd';
import { Button, IconButton, MenuItemsSurface, MenuRoot, MenuTransition, MenuTrigger } from '@/components/ui';
import { useDocumentSelection } from './dnd/DocumentSelectionContext';
import type { DocumentActions } from './document-actions';
import { MoveToFolderItems } from './MoveToFolderItems';
import { CloseIcon, FolderIcon, TrashIcon } from './window/finderIcons';

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable]'));

/**
 * Floating bar shown while documents are selected: count, select all, move to a
 * folder, delete, and clear. Also owns the selection keyboard shortcuts
 * (Esc clears, Cmd/Ctrl+A selects everything visible).
 */
export function SelectionActionBar({ actions }: { actions: DocumentActions }) {
  const selection = useDocumentSelection();
  const dragging = useDragLayer((monitor) => monitor.isDragging());
  const { selectionSize, visibleCount, clear, selectAll } = selection;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && visibleCount > 0) {
        event.preventDefault();
        selectAll();
      } else if (event.key === 'Escape' && selectionSize > 0) {
        // Leave Escape to an open menu or dialog; only clear when nothing else owns it.
        // A dialog still fading out no longer owns it.
        if (document.querySelector('[role="dialog"]:not([data-closing]), [role="menu"]')) return;
        clear();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear, selectAll, selectionSize, visibleCount]);

  if (selectionSize === 0 || dragging) return null;
  const docs = selection.getSelectedDocs();

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-3">
      <div
        role="toolbar"
        aria-label="Selected documents"
        className="pointer-events-auto flex max-w-full animate-fade-in items-center gap-1 rounded-xl border border-line bg-surface-solid p-1.5 shadow-elev-3"
      >
        <IconButton size="sm" onClick={clear} aria-label="Clear selection" title="Clear selection (Esc)">
          <CloseIcon className="h-4 w-4" />
        </IconButton>
        <span role="status" aria-live="polite" className="whitespace-nowrap px-1.5 text-sm font-medium text-foreground tabular-nums">
          {selectionSize} selected
        </span>
        {selectionSize < visibleCount && (
          <Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={selectAll}>
            Select all
          </Button>
        )}
        <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        <MenuRoot as="div" className="relative inline-flex">
          <MenuTrigger as={Button} variant="ghost" size="sm" className="gap-1.5">
            <FolderIcon className="h-4 w-4" />
            Move
          </MenuTrigger>
          <MenuTransition>
            <MenuItemsSurface anchor="top" className="z-50 mb-2 min-w-[200px] max-w-[260px] focus:outline-none">
              <MoveToFolderItems
                docs={docs}
                folders={actions.folders}
                onMove={actions.onMove}
                onNewFolder={actions.onNewFolder}
              />
            </MenuItemsSurface>
          </MenuTransition>
        </MenuRoot>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-danger hover:bg-danger-wash hover:text-danger"
          onClick={() => actions.onDelete(docs)}
        >
          <TrashIcon className="h-4 w-4" />
          Delete
        </Button>
      </div>
    </div>
  );
}
