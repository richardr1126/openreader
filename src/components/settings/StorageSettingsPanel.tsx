'use client';

import { useState, type ReactNode } from 'react';
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

function SkeletonBar({ className }: { className: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded bg-surface-sunken ${className}`} />;
}

function UsageRow({
  label,
  bytes,
  detail,
  loading,
  action,
}: {
  label: string;
  bytes: number | undefined;
  detail?: string;
  loading: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {loading ? <SkeletonBar className="mt-1.5 h-2.5 w-20" /> : detail ? <div className="mt-0.5 text-xs text-faint">{detail}</div> : null}
      </div>
      {loading
        ? <SkeletonBar className="h-4 w-16" />
        : <span className="text-sm font-medium tabular-nums text-foreground">{bytes === undefined ? '—' : formatBytes(bytes)}</span>}
      <div className="w-24 shrink-0 text-right">{action}</div>
    </div>
  );
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
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
      toast.success(`${target === 'orphaned' ? 'Reclaimed' : 'Deleted'} audio for ${plural(reclaimedDocuments, 'document')}.`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to delete audio'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage(sessionKey) }),
  });

  const usage = usageQuery.data;
  const loading = usageQuery.isPending;
  const busyTarget = reclaimMutation.isPending ? reclaimMutation.variables : null;
  const pendingCopy = pendingTarget ? CONFIRM_COPY[pendingTarget] : null;

  return (
    <section className="space-y-3" aria-label="Library storage" aria-busy={loading}>
      <div className="divide-y divide-line-soft rounded-lg border border-line bg-surface">
        <UsageRow
          label="Audio"
          bytes={usage?.audioBytes}
          loading={loading}
          action={(
            <Button
              size="xs"
              variant="outline"
              aria-label="Delete all audio"
              onClick={() => setPendingTarget('all')}
              disabled={loading || reclaimMutation.isPending}
            >
              {busyTarget === 'all' ? 'Deleting…' : 'Delete all'}
            </Button>
          )}
        />
        <UsageRow
          label="Orphaned audio"
          bytes={usage?.orphanedAudioBytes}
          detail={usage && usage.orphanedDocumentCount > 0 ? plural(usage.orphanedDocumentCount, 'removed document') : undefined}
          loading={loading}
          action={(
            <Button
              size="xs"
              variant="outline"
              aria-label="Reclaim orphaned audio"
              onClick={() => setPendingTarget('orphaned')}
              disabled={loading || reclaimMutation.isPending || usage?.orphanedAudioBytes === 0}
            >
              {busyTarget === 'orphaned' ? 'Reclaiming…' : 'Reclaim'}
            </Button>
          )}
        />
        <UsageRow
          label="Document data"
          bytes={usage?.documentDataBytes}
          detail={usage ? plural(usage.documentCount, 'document') : undefined}
          loading={loading}
        />
      </div>
      {usageQuery.isError ? (
        <p role="status" className="px-1 text-xs text-danger">
          {usageQuery.error instanceof Error ? usageQuery.error.message : 'Failed to load storage usage'}
        </p>
      ) : null}
      {usage?.truncated ? (
        <p className="px-1 text-xs text-soft">Totals are partial; your library has more stored objects than one scan covers.</p>
      ) : null}
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
