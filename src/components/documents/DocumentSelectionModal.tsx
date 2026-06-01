'use client';

import { useEffect, useState } from 'react';
import { BaseDocument } from '@/types/documents';
import { Button, ModalFrame, ModalTitle } from '@/components/ui';

interface DocumentSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (selectedFiles: BaseDocument[]) => void;
  title: string;
  confirmLabel: string;
  isProcessing: boolean;
  defaultSelected?: boolean;
  files: BaseDocument[];
  isLoading?: boolean;
  errorMessage?: string | null;
}

export function DocumentSelectionModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  isProcessing,
  defaultSelected = false,
  files,
  isLoading = false,
  errorMessage = null,
}: DocumentSelectionModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (defaultSelected) {
      setSelectedIds(new Set(files.map((f) => f.id)));
    } else {
      setSelectedIds(new Set());
    }
    setLastSelectedId(null);
  }, [isOpen, files, defaultSelected]);

  const toggleSelection = (id: string, multiSelect: boolean, rangeSelect: boolean) => {
    const newSelected = new Set(multiSelect ? selectedIds : []);

    if (rangeSelect && lastSelectedId && files.some((f) => f.id === lastSelectedId)) {
      const lastIndex = files.findIndex((f) => f.id === lastSelectedId);
      const currentIndex = files.findIndex((f) => f.id === id);
      const start = Math.min(lastIndex, currentIndex);
      const end = Math.max(lastIndex, currentIndex);

      for (let i = start; i <= end; i++) {
        newSelected.add(files[i].id);
      }
    } else {
      if (newSelected.has(id)) {
        newSelected.delete(id);
      } else {
        newSelected.add(id);
      }
    }

    setSelectedIds(newSelected);
    setLastSelectedId(id);
  };

  const handleRowClick = (e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey) {
      toggleSelection(id, true, false);
    } else if (e.shiftKey) {
      toggleSelection(id, true, true);
    } else {
      // "Finder" behavior: Click selects only this one (unless multiselect modifier used)
      // Checkbox click is handled separately to allow toggling without clearing
      const newSelected = new Set<string>();
      newSelected.add(id);
      setSelectedIds(newSelected);
      setLastSelectedId(id);
    }
  };

  const handleCheckboxChange = (id: string, checked: boolean) => {
    const newSelected = new Set(selectedIds);
    if (checked) newSelected.add(id);
    else newSelected.delete(id);
    setSelectedIds(newSelected);
    setLastSelectedId(id);
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
        setSelectedIds(new Set(files.map(f => f.id)));
    } else {
        setSelectedIds(new Set());
    }
  };

  const selectedCount = selectedIds.size;
  const allSelected = files.length > 0 && selectedCount === files.length;
  const isIndeterminate = selectedCount > 0 && selectedCount < files.length;

  const handleConfirmClick = () => {
    const selectedFiles = files.filter((f) => selectedIds.has(f.id));
    onConfirm(selectedFiles);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <ModalFrame open={isOpen} onClose={onClose} size="lg" panelClassName="flex h-[80vh] flex-col" className="z-[60]">
      <ModalTitle className="mb-4 flex flex-shrink-0 items-center justify-between">
        {title}
        {files.length > 0 && (
          <div className="flex items-center text-sm font-normal">
            <label className="flex items-center gap-2 cursor-pointer select-none text-soft hover:text-foreground transition-colors">
              <input
                type="checkbox"
                className="rounded border-muted text-accent focus:ring-accent-line"
                checked={allSelected}
                ref={input => {
                  if (input) input.indeterminate = isIndeterminate;
                }}
                onChange={(e) => handleSelectAll(e.target.checked)}
              />
              Select All
            </label>
          </div>
        )}
      </ModalTitle>

      <div className="flex-1 overflow-auto border border-line rounded-lg bg-background p-2 min-h-0">
        {isLoading ? (
          <DocumentSelectionSkeleton />
        ) : errorMessage ? (
          <div className="flex items-center justify-center h-full text-danger">{errorMessage}</div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-soft">No documents found.</div>
        ) : (
          <div className="space-y-0.5">
            {files.map((file) => {
              const isSelected = selectedIds.has(file.id);
              return (
                <div
                  key={file.id}
                  onClick={(e) => handleRowClick(e, file.id)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-sm select-none ${
                    isSelected ? 'bg-accent-wash' : 'hover:bg-accent-wash'
                  }`}
                >
                  <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => handleCheckboxChange(file.id, e.target.checked)}
                      className="rounded border-muted text-accent focus:ring-accent-line"
                    />
                  </div>
                  <div
                    className={`flex-1 truncate ${
                      isSelected ? 'text-accent font-medium' : 'text-foreground'
                    }`}
                  >
                    {file.name}
                  </div>
                  <div className="text-soft text-xs whitespace-nowrap">{formatSize(file.size)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-3 flex-shrink-0">
        <Button variant="outline" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleConfirmClick}
          disabled={isLoading || selectedCount === 0 || isProcessing}
        >
          {isProcessing ? 'Processing...' : `${confirmLabel} ${selectedCount > 0 ? `(${selectedCount})` : ''}`}
        </Button>
      </div>
    </ModalFrame>
  );
}

function DocumentSelectionSkeleton() {
  const rows = Array.from({ length: 9 });
  return (
    <div className="h-full animate-pulse space-y-0.5" aria-label="Loading documents" aria-busy="true">
      {rows.map((_, index) => (
        <div key={index} className="flex items-center gap-3 px-3 py-2 rounded-md">
          <div className="h-4 w-4 rounded-sm bg-surface-sunken border border-line" />
          <div className="h-3.5 flex-1 rounded bg-surface-sunken" />
          <div className="h-3 w-14 rounded bg-surface-sunken" />
        </div>
      ))}
    </div>
  );
}
