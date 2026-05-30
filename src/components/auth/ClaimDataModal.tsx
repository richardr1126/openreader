'use client';

import { Fragment, useState } from 'react';
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
  Button,
} from '@headlessui/react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';

export type ClaimableCounts = {
  documents: number;
  audiobooks: number;
  preferences: number;
  progress: number;
};

function toClaimableCounts(value: unknown): ClaimableCounts {
  const rec = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  return {
    documents: Number(rec.documents ?? 0),
    audiobooks: Number(rec.audiobooks ?? 0),
    preferences: Number(rec.preferences ?? 0),
    progress: Number(rec.progress ?? 0),
  };
}

type ClaimDataModalProps = {
  isOpen: boolean;
  claimableCounts: ClaimableCounts;
  onDismiss: () => void;
  onClaimed: () => void;
};

export default function ClaimDataModal({
  isOpen,
  claimableCounts,
  onDismiss,
  onClaimed,
}: ClaimDataModalProps) {
  const router = useRouter();
  const [isClaiming, setIsClaiming] = useState(false);

  const handleClaim = async () => {
    setIsClaiming(true);
    try {
      const res = await fetch('/api/user/claim', {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        const claimed = toClaimableCounts(data?.claimed);
        toast.success(
          `Successfully claimed ${claimed.documents} documents, `
          + `${claimed.audiobooks} audiobooks, `
          + `${claimed.preferences} preference set(s), and `
          + `${claimed.progress} reading progress record(s)!`,
        );
        onClaimed();
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => null) as { error?: string } | null;
      toast.error(data?.error || 'Failed to claim data.');
    } catch {
      toast.error('Failed to claim data.');
    } finally {
      setIsClaiming(false);
    }
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[80]" onClose={onDismiss}>
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
              <DialogPanel data-testid="claim-modal" className="w-full max-w-md transform rounded-2xl bg-base p-6 text-left align-middle shadow-xl transition-all">
                <DialogTitle
                  as="h3"
                  className="text-lg font-semibold leading-6 text-foreground mb-4"
                >
                  Existing Data Found
                </DialogTitle>

                <p className="text-sm text-muted mb-2">
                  We found existing anonymous data from before auth was enabled.
                  Claim it now to attach it to your account.
                </p>

                <div className="mb-4 rounded-lg border border-offbase bg-offbase/40 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Claimable data</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground/90">
                    <li>{claimableCounts.documents} document(s)</li>
                    <li>{claimableCounts.audiobooks} audiobook(s)</li>
                    <li>{claimableCounts.preferences} preference set(s)</li>
                    <li>{claimableCounts.progress} reading progress record(s)</li>
                  </ul>
                </div>

                <p className="text-xs text-muted/70 mb-6 italic">
                  ⚠️ First user to claim this data will own it and revoke access for anyone else.
                </p>

                <div className="flex justify-end gap-3">
                  <Button
                    data-testid="claim-dismiss-button"
                    type="button"
                    onClick={onDismiss}
                    disabled={isClaiming}
                    className="inline-flex justify-center rounded-lg bg-background px-3 py-1.5 text-sm 
                             font-medium text-foreground hover:bg-offbase focus:outline-none 
                             focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                             transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-accent
                             disabled:opacity-50"
                  >
                    Dismiss
                  </Button>
                  <Button
                    data-testid="claim-submit-button"
                    type="button"
                    onClick={handleClaim}
                    disabled={isClaiming}
                    className="inline-flex justify-center rounded-lg bg-accent px-3 py-1.5 text-sm 
                             font-medium text-background hover:bg-secondary-accent focus:outline-none 
                             focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                             transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-background
                             disabled:opacity-50"
                  >
                    {isClaiming ? 'Claiming...' : 'Claim Data'}
                  </Button>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
