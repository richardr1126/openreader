'use client';

import { useRouter } from 'next/navigation';
import { DotsHorizontalIcon } from '@/components/icons/Icons';
import type { DocumentListDocument } from '@/types/documents';
import {
  IconButton,
  MenuActionItem,
  MenuItemsSurface,
  MenuRoot,
  MenuTransition,
  MenuTrigger,
  cn,
} from '@/components/ui';
import { useDocumentSelection } from './dnd/DocumentSelectionContext';
import type { DocumentActions } from './document-actions';
import { MoveToFolderItems } from './MoveToFolderItems';
import { CheckMarkIcon, TrashIcon } from './window/finderIcons';

/**
 * Three-dots menu for one document. When the document is part of a multi-item
 * selection the file actions apply to the whole selection, like Finder.
 */
export function DocumentActionsMenu({
  doc,
  actions,
  size = 'sm',
  className,
  iconClassName = 'h-2 w-4',
}: {
  doc: DocumentListDocument;
  actions: DocumentActions;
  size?: 'xs' | 'sm';
  className?: string;
  iconClassName?: string;
}) {
  const router = useRouter();
  const selection = useDocumentSelection();
  const selected = selection.isSelected(doc);
  const targets = selected && selection.selectionSize > 1 ? selection.getSelectedDocs() : [doc];
  const multi = targets.length > 1;

  return (
    <MenuRoot as="div" className="relative inline-flex shrink-0 items-center text-left">
      <MenuTrigger
        as={IconButton}
        size={size}
        className={className}
        aria-label={`Actions for ${doc.name}`}
        title="Actions"
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
      >
        <DotsHorizontalIcon className={iconClassName} />
      </MenuTrigger>
      <MenuTransition>
        <MenuItemsSurface anchor="bottom end" className="z-50 mt-1 min-w-[200px] max-w-[260px] focus:outline-none">
          {!multi && (
            <MenuActionItem onClick={() => router.push(`/${doc.type}/${encodeURIComponent(doc.id)}`)}>
              <span className="h-4 w-4 shrink-0" aria-hidden="true" />
              Open
            </MenuActionItem>
          )}
          <MenuActionItem onClick={() => selection.toggle(doc)}>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
              {selected && <CheckMarkIcon className="h-3.5 w-3.5" />}
            </span>
            {selected ? 'Deselect' : 'Select'}
          </MenuActionItem>
          <div className={cn('my-1 border-t border-line-soft')} role="separator" />
          <MoveToFolderItems
            docs={targets}
            folders={actions.folders}
            onMove={actions.onMove}
            onNewFolder={actions.onNewFolder}
          />
          <div className="my-1 border-t border-line-soft" role="separator" />
          <MenuActionItem tone="danger" onClick={() => actions.onDelete(targets)}>
            <TrashIcon className="h-4 w-4 shrink-0" />
            {multi ? `Delete ${targets.length} items` : 'Delete'}
          </MenuActionItem>
        </MenuItemsSurface>
      </MenuTransition>
    </MenuRoot>
  );
}
