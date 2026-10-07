'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  fetchLibraryStorageUsage,
  reclaimLibraryAudio,
  type LibraryAudioReclaimTarget,
} from '@/lib/client/api/storage';
import { queryKeys } from '@/lib/client/query-keys';
import { formatBytes } from '@/lib/shared/format-bytes';

function UsageStat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <div className="text-xs text-soft">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-faint">{detail}</div> : null}
    </div>
  );
}

const CONFIRM_COPY: Record<LibraryAudioReclaimTarget, { title: string; message: string; confirmText: string }> = {
  orphaned: {
    title: 'Reclaim orphaned audio?',
    message: 'Audio and audiobook exports left by documents you no longer have will be deleted.',
    confirmText: 'Reclaim',
  },
  all: {
    title: 'Delete all audio?',
    message: 'All generated audio and audiobook exports for every document will be deleted. Playback regenerates audio the next time you press play. Open readers should be reloaded.',
    confirmText: 'Delete all audio',
  },
};

/** Library-wide storage totals and audio cleanup for the signed-in user. */
export function StorageSettingsPanel() {
  const { data: session } = useAuthSession();
  const queryClient = useQueryClient();
  const sessionKey = session?.user?.id ?? 'no-session';
  const [pendingTarget, setPendingTarget] = useState<LibraryAudioReclaimTarget | null>(null);

  const usageQuery = useQuery({
    queryKey: queryKeys.libraryStorageUsage(sessionKey),
    queryFn: ({ signal }) => fetchLibraryStorageUsage(signal),
    staleTime: 30_000,
    retry: false,
  });

  const reclaimMutation = useMutation({
    mutationFn: (target: LibraryAudioReclaimTarget) => reclaimLibraryAudio(target),
    onSuccess: ({ reclaimedDocuments }, target) => {
      if (reclaimedDocuments === 0) {
        toast.success(target === 'orphaned' ? 'No orphaned audio to reclaim.' : 'No audio to delete.');
        return;
      }
      toast.success(`${target === 'orphaned' ? 'Reclaimed' : 'Deleted'} audio for ${reclaimedDocuments} document${reclaimedDocuments === 1 ? '' : 's'}.`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to delete audio'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage(sessionKey) }),
  });

  const usage = usageQuery.data;
  const loadingValue = usageQuery.isPending ? '…' : '—';
  const pendingCopy = pendingTarget ? CONFIRM_COPY[pendingTarget] : null;

  return (
    <section className="space-y-4 rounded-lg border border-line bg-background p-4" aria-labelledby="storage-usage-heading">
      <div>
        <h3 id="storage-usage-heading" className="text-sm font-semibold text-foreground">Library storage</h3>
        <p className="mt-1 text-xs text-soft">
          Generated audio is cached so documents play instantly the next time. Document data is shared layout
          analysis, previews, and reading plans that are reused automatically.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <UsageStat
          label="Audio"
          value={usage ? formatBytes(usage.audioBytes) : loadingValue}
        />
        <UsageStat
          label="Orphaned audio"
          value={usage ? formatBytes(usage.orphanedAudioBytes) : loadingValue}
          detail={usage && usage.orphanedDocumentCount > 0
            ? `${usage.orphanedDocumentCount} removed document${usage.orphanedDocumentCount === 1 ? '' : 's'}`
            : undefined}
        />
        <UsageStat
          label="Document data"
          value={usage ? formatBytes(usage.documentDataBytes) : loadingValue}
          detail={usage ? `${usage.documentCount} document${usage.documentCount === 1 ? '' : 's'}` : undefined}
        />
      </div>
      {usageQuery.isError ? (
        <p className="text-xs text-danger">
          {usageQuery.error instanceof Error ? usageQuery.error.message : 'Failed to load storage usage'}
        </p>
      ) : null}
      {usage?.truncated ? (
        <p className="text-xs text-soft">Totals are partial; your library has more stored objects than one scan covers.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => setPendingTarget('orphaned')}
          disabled={reclaimMutation.isPending || usage?.orphanedAudioBytes === 0}
        >
          {reclaimMutation.isPending && reclaimMutation.variables === 'orphaned' ? 'Reclaiming…' : 'Reclaim orphaned audio'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPendingTarget('all')}
          disabled={reclaimMutation.isPending}
        >
          {reclaimMutation.isPending && reclaimMutation.variables === 'all' ? 'Deleting…' : 'Delete all audio'}
        </Button>
      </div>
      <ConfirmDialog
        isOpen={pendingCopy !== null}
        onClose={() => setPendingTarget(null)}
        onConfirm={() => {
          const target = pendingTarget;
          setPendingTarget(null);
          if (target) reclaimMutation.mutate(target);
        }}
        title={pendingCopy?.title ?? ''}
        message={pendingCopy?.message ?? ''}
        confirmText={pendingCopy?.confirmText}
        isDangerous={pendingTarget === 'all'}
      />
    </section>
  );
}
