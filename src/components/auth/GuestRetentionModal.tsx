'use client';

import { Button, ModalFrame, ModalTitle } from '@/components/ui';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';

/** Onboarding step shown to a guest while idle guest accounts are being deleted. */
export function GuestRetentionModal({
  days,
  isOpen,
  onContinue,
  onCreateAccount,
}: {
  days: number;
  isOpen: boolean;
  onContinue: () => void;
  onCreateAccount: () => void;
}) {
  const canSignUp = useRuntimeConfig().signupPolicy !== 'closed';

  return (
    <ModalFrame
      open={isOpen}
      onClose={onContinue}
      panelTestId="guest-retention-modal"
    >
      <ModalTitle>{`Guest data is deleted after ${days} ${days === 1 ? 'day' : 'days'} without use`}</ModalTitle>
      {canSignUp ? (
        <p className="mt-3 text-sm leading-relaxed text-soft">
          An account keeps your documents, reading progress and settings. Generated audio isn&apos;t transferred.
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {canSignUp ? (
          <>
            <Button variant="outline" size="lg" onClick={onContinue}>Continue as guest</Button>
            <Button variant="primary" size="lg" onClick={onCreateAccount}>Create an account</Button>
          </>
        ) : (
          <Button variant="primary" size="lg" onClick={onContinue}>Continue</Button>
        )}
      </div>
    </ModalFrame>
  );
}
