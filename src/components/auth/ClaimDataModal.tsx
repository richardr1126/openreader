'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button, ModalFrame, ModalTitle } from '@/components/ui';

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
    <ModalFrame open={isOpen} onClose={onDismiss} panelTestId="claim-modal" className="z-[80]">
      <ModalTitle className="mb-4">Existing Data Found</ModalTitle>

      <p className="text-sm text-soft mb-2">
        We found existing anonymous data from before auth was enabled.
        Claim it now to attach it to your account.
      </p>

      <div className="mb-4 rounded-lg border border-line bg-surface-sunken p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-soft">Claimable data</div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-soft">
          <li>{claimableCounts.documents} document(s)</li>
          <li>{claimableCounts.audiobooks} audiobook(s)</li>
          <li>{claimableCounts.preferences} preference set(s)</li>
          <li>{claimableCounts.progress} reading progress record(s)</li>
        </ul>
      </div>

      <p className="text-xs text-faint mb-6 italic">
        ⚠️ First user to claim this data will own it and revoke access for anyone else.
      </p>

      <div className="flex justify-end gap-3">
        <Button
          data-testid="claim-dismiss-button"
          variant="outline"
          size="sm"
          onClick={onDismiss}
          disabled={isClaiming}
        >
          Dismiss
        </Button>
        <Button
          data-testid="claim-submit-button"
          variant="primary"
          size="sm"
          onClick={handleClaim}
          disabled={isClaiming}
        >
          {isClaiming ? 'Claiming...' : 'Claim Data'}
        </Button>
      </div>
    </ModalFrame>
  );
}
