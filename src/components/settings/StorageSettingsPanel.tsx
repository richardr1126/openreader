'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AudioWaveIcon, DocumentIcon, TrashIcon } from '@/components/icons/Icons';
import { Button, RowIcon } from '@/components/ui';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useDesktopBridge } from '@/hooks/useDesktopBridge';
import {
  fetchLibraryStorageUsage,
  reclaimLibraryAudio,
  type LibraryAudioReclaimTarget,
} from '@/lib/client/api/storage';
import { queryKeys } from '@/lib/client/query-keys';
import { formatBytes } from '@/lib/shared/format-bytes';

const CARD_CLASS = 'divide-y divide-line-soft rounded-lg border border-line-soft bg-surface-solid';

function UsageRow({
  label,
  icon,
  bytes,
  detail,
  action,
}: {
  label: string;
  icon: ReactNode;
  bytes: number | undefined;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-3 py-2.5">
      <RowIcon>{icon}</RowIcon>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {detail ? <div className="mt-0.5 text-xs text-faint">{detail}</div> : null}
      </div>
      <span className="text-sm font-medium tabular-nums text-foreground">{bytes === undefined ? '—' : formatBytes(bytes)}</span>
      <div className="w-24 shrink-0 text-right">{action}</div>
    </div>
  );
}

function StorageSkeleton() {
  return (
    <div className={`animate-pulse ${CARD_CLASS}`} aria-label="Loading storage usage" aria-busy="true">
      {[true, true, false].map((hasAction, index) => (
        <div key={index} className="flex min-h-14 items-center gap-3 px-3 py-2.5">
          <div className="h-7 w-7 shrink-0 rounded-md bg-offbase" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-4 w-28 rounded bg-offbase" />
            <div className="h-3 w-20 rounded bg-offbase" />
          </div>
          <div className="h-4 w-14 rounded bg-offbase" />
          <div className="flex w-24 shrink-0 justify-end">
            {hasAction ? <div className="h-6 w-16 rounded-md bg-offbase" /> : null}
          </div>
        </div>
      ))}
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
  const revealDataFolder = useDesktopBridge()?.revealDataFolder;

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
  const busyTarget = reclaimMutation.isPending ? reclaimMutation.variables : null;
  const pendingCopy = pendingTarget ? CONFIRM_COPY[pendingTarget] : null;

  return (
    <section className="space-y-3" aria-label="Library storage">
      {usageQuery.isPending ? <StorageSkeleton /> : (
        <div className={CARD_CLASS}>
          <UsageRow
            label="Audio"
            icon={<AudioWaveIcon />}
            bytes={usage?.audioBytes}
            action={(
              <Button
                size="xs"
                variant="outline"
                aria-label="Delete all audio"
                onClick={() => setPendingTarget('all')}
                disabled={reclaimMutation.isPending}
              >
                {busyTarget === 'all' ? 'Deleting…' : 'Delete all'}
              </Button>
            )}
          />
          <UsageRow
            label="Orphaned audio"
            icon={<TrashIcon />}
            bytes={usage?.orphanedAudioBytes}
            detail={usage && usage.orphanedDocumentCount > 0 ? plural(usage.orphanedDocumentCount, 'removed document') : undefined}
            action={(
              <Button
                size="xs"
                variant="outline"
                aria-label="Reclaim orphaned audio"
                onClick={() => setPendingTarget('orphaned')}
                disabled={reclaimMutation.isPending || usage?.orphanedAudioBytes === 0}
              >
                {busyTarget === 'orphaned' ? 'Reclaiming…' : 'Reclaim'}
              </Button>
            )}
          />
          <UsageRow
            label="Document data"
            icon={<DocumentIcon />}
            bytes={usage?.documentDataBytes}
            detail={usage ? plural(usage.documentCount, 'document') : undefined}
          />
        </div>
      )}
      {usageQuery.isError ? (
        <p role="status" className="px-1 text-xs text-danger">
          {usageQuery.error instanceof Error ? usageQuery.error.message : 'Failed to load storage usage'}
        </p>
      ) : null}
      {revealDataFolder ? (
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="text-xs text-soft">Your library, audio and settings live in OpenReader&apos;s data folder.</p>
          <Button size="xs" variant="outline" onClick={() => void revealDataFolder()}>
            Show data folder
          </Button>
        </div>
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
