import { KeyboardEvent } from 'react';
import { Input, ModalFrame, ModalTitle } from '@/components/ui';

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
    <ModalFrame open={isOpen} onClose={onClose}>
      <ModalTitle>Create New Folder</ModalTitle>
      <div className="mt-4">
        <Input
          type="text"
          value={folderName}
          onChange={(e) => onFolderNameChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Enter folder name"
          controlSize="lg"
          autoFocus
        />
        <p className="mt-2 text-xs text-soft">Press Enter to create or Escape to cancel</p>
      </div>
    </ModalFrame>
  );
}
