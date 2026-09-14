import { Button, ModalFrame, ModalTitle } from '@/components/ui';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDangerous?: boolean;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDangerous = false,
}: ConfirmDialogProps) {
  return (
    <ModalFrame open={isOpen} onClose={onClose} panelTestId="confirm-dialog-panel">
      <ModalTitle>{title}</ModalTitle>
      <div className="mt-2">
        <p className="text-sm text-soft break-words">{message}</p>
      </div>

      <div className="mt-6 flex justify-end space-x-3">
        <Button autoFocus variant="outline" size="sm" onClick={onClose}>
          {cancelText}
        </Button>
        <Button
          variant={isDangerous ? 'danger' : 'primary'}
          size="sm"
          className="text-wrap"
          onClick={onConfirm}
        >
          {confirmText}
        </Button>
      </div>
    </ModalFrame>
  );
}
