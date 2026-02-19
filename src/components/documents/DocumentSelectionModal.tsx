'use client';

import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { Fragment, useEffect, useState } from 'react';
import { BaseDocument } from '@/types/documents';

interface DocumentSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (selectedFiles: BaseDocument[]) => void;
  title: string;
  confirmLabel: string;
  isProcessing: boolean;
  defaultSelected?: boolean;
  /**
   * Data source:
   * 1. `initialFiles`: Pass local files directly (synchronous).
   * 2. `fetcher`: Pass an async function to load files (e.g. from server).
   */
  initialFiles?: BaseDocument[];
  fetcher?: () => Promise<BaseDocument[]>;
}

export function DocumentSelectionModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  isProcessing,
  defaultSelected = false,
  initialFiles,
  fetcher,
}: DocumentSelectionModalProps) {
  const [files, setFiles] = useState<BaseDocument[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (initialFiles) {
        setFiles(initialFiles);
        if (defaultSelected) {
          setSelectedIds(new Set(initialFiles.map((f) => f.id)));
        } else {
          setSelectedIds(new Set());
        }
        setLastSelectedId(null);
      } else if (fetcher) {
        setIsLoading(true);
        fetcher()
          .then((data) => {
            setFiles(data);
            if (defaultSelected) {
              setSelectedIds(new Set(data.map((f) => f.id)));
            } else {
              setSelectedIds(new Set());
            }
            setLastSelectedId(null);
          })
          .catch((err) => console.error('Failed to load documents:', err))
          .finally(() => setIsLoading(false));
      } else {
        setFiles([]);
        setSelectedIds(new Set());
      }
    }
  }, [isOpen, initialFiles, fetcher, defaultSelected]);

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
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[60]" onClose={onClose}>
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 overlay-dim backdrop-blur-sm" />
        </TransitionChild>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-start justify-center p-4 pt-6 text-center sm:items-center sm:pt-4">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="w-full max-w-2xl transform rounded-2xl bg-base p-6 text-left align-middle shadow-xl transition-all flex flex-col h-[80vh]">
                <DialogTitle
                  as="h3"
                  className="text-lg font-semibold leading-6 text-foreground mb-4 flex-shrink-0 flex justify-between items-center"
                >
                  {title}
                  {files.length > 0 && (
                      <div className="flex items-center text-sm font-normal">
                          <label className="flex items-center gap-2 cursor-pointer select-none text-muted hover:text-foreground transition-colors">
                              <input 
                                  type="checkbox"
                                  className="rounded border-muted text-accent focus:ring-accent"
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
                </DialogTitle>

                <div className="flex-1 overflow-auto border border-offbase rounded-lg bg-background p-2 min-h-0">
                  {isLoading ? (
                    <div className="flex items-center justify-center h-full text-muted">Loading documents...</div>
                  ) : files.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-muted">No documents found.</div>
                  ) : (
                    <div className="space-y-0.5">
                      {files.map((file) => {
                        const isSelected = selectedIds.has(file.id);
                        return (
                          <div
                            key={file.id}
                            onClick={(e) => handleRowClick(e, file.id)}
                            className={`flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-sm select-none
                                            ${isSelected ? 'bg-accent/10' : 'hover:bg-offbase'}
                                        `}
                          >
                            <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleCheckboxChange(file.id, e.target.checked)}
                                className="rounded border-muted text-accent focus:ring-accent"
                              />
                            </div>
                            <div
                              className={`flex-1 truncate ${
                                isSelected ? 'text-accent font-medium' : 'text-foreground'
                              }`}
                            >
                              {file.name}
                            </div>
                            <div className="text-muted text-xs whitespace-nowrap">{formatSize(file.size)}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="mt-4 flex justify-end gap-3 flex-shrink-0">
                  <button
                    type="button"
                    className="inline-flex justify-center rounded-lg bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-offbase focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                    onClick={onClose}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="inline-flex justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background hover:bg-secondary-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleConfirmClick}
                    disabled={selectedCount === 0 || isProcessing}
                  >
                    {isProcessing ? 'Processing...' : `${confirmLabel} ${selectedCount > 0 ? `(${selectedCount})` : ''}`}
                  </button>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
