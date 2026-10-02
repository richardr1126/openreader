'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';

type PlanChangeRequest = {
  /** Lowercase noun phrase completing "Change ...?", e.g. "the voice". */
  setting: string;
  apply: () => void;
  /** Runs when the user backs out, so controls holding local state can revert. */
  onCancel?: () => void;
};

/**
 * Voice, native speed, language, segment length, and PDF skip kinds are part of
 * the playback plan identity. Applying one rebuilds the plan, stops playback,
 * and generates new audio, so each goes through this single confirmation.
 */
export function usePlanChangeConfirm(): {
  confirmPlanChange: (request: PlanChangeRequest) => void;
  planChangeDialog: ReactNode;
} {
  const [request, setRequest] = useState<PlanChangeRequest | null>(null);
  const [open, setOpen] = useState(false);

  const confirmPlanChange = useCallback((next: PlanChangeRequest) => {
    setRequest(next);
    setOpen(true);
  }, []);

  // Headless UI also reports outside clicks while the dialog animates out; by
  // then the choice is made, and a late cancel must not undo a confirmed change.
  const handleClose = useCallback(() => {
    if (!open) return;
    setOpen(false);
    request?.onCancel?.();
  }, [open, request]);

  const handleConfirm = useCallback(() => {
    setOpen(false);
    request?.apply();
  }, [request]);

  // `request` stays set while the dialog animates out so its text does not blank.
  const planChangeDialog = (
    <ConfirmDialog
      isOpen={open}
      onClose={handleClose}
      onConfirm={handleConfirm}
      title={`Change ${request?.setting ?? 'this setting'}?`}
      message={
        'This changes how the document is turned into audio. '
        + 'Playback will stop, and audio already generated with the current settings will not be used. '
        + 'New audio is generated as you listen, which may take a moment and use your TTS provider.'
      }
      confirmText="Change and regenerate"
      cancelText="Cancel"
    />
  );

  return { confirmPlanChange, planChangeDialog };
}
