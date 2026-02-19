import { Fragment, KeyboardEvent } from 'react';
import { Dialog, DialogPanel, DialogTitle, Input, Transition, TransitionChild } from '@headlessui/react';

interface CreateFolderDialogProps {
  isOpen: boolean;
  folderName: string;
  onFolderNameChange: (name: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onClose: () => void;
}

export function CreateFolderDialog({
  isOpen,
  folderName,
  onFolderNameChange,
  onKeyDown,
  onClose,
}: CreateFolderDialogProps) {
  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
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
              <DialogPanel className="w-full max-w-md transform rounded-2xl bg-base p-6 text-left align-middle shadow-xl transition-all">
                <DialogTitle as="h3" className="text-lg font-semibold text-foreground">
                  Create New Folder
                </DialogTitle>
                <div className="mt-4">
                  <Input
                    type="text"
                    value={folderName}
                    onChange={(e) => onFolderNameChange(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Enter folder name"
                    className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    autoFocus
                  />
                  <p className="mt-2 text-xs text-muted">Press Enter to create or Escape to cancel</p>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}