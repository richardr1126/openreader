'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button, Section } from '@/components/ui';
import { useTTS } from '@/contexts/TTSContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  deleteDocumentAudio,
  fetchDocumentStorageUsage,
  reclaimUnusedDocumentAudio,
} from '@/lib/client/api/storage';
import { queryKeys } from '@/lib/client/query-keys';
import { formatBytes } from '@/lib/shared/format-bytes';

type PendingAction = 'reclaim' | 'delete' | null;

function UsageRow({ label, bytes }: { label: string; bytes: number | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-foreground">{label}</span>
      <span className="tabular-nums text-soft">{bytes === undefined ? '…' : formatBytes(bytes)}</span>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'Cleanup confirmation timed out. Audio may already be removed. Reload the reader before trying playback again.';
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Per-document storage: audio for the current playback settings, audio left by
 * other settings or older versions of the document, and shared document data.
 */
export function DocumentStorageSection({ documentId }: { documentId: string }) {
  const { playbackPlanPayload, clearSegmentCaches } = useTTS();
  const { data: session } = useAuthSession();
  const queryClient = useQueryClient();
  const sessionKey = session?.user?.id ?? 'no-session';
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const payload = playbackPlanPayload?.documentId === documentId ? playbackPlanPayload : null;

  const usageQuery = useQuery({
    queryKey: queryKeys.documentStorageUsage(sessionKey, documentId, JSON.stringify(payload)),
    queryFn: ({ signal }) => fetchDocumentStorageUsage(payload!, signal),
    enabled: Boolean(payload),
    staleTime: 30_000,
    retry: false,
  });

  const refreshUsage = () => queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage(sessionKey) });

  const reclaimMutation = useMutation({
    mutationFn: () => reclaimUnusedDocumentAudio(payload!),
    onSuccess: (result) => {
      toast.success(result.reclaimedVariants > 0
        ? `Reclaimed unused audio from ${result.reclaimedVariants} other setting${result.reclaimedVariants === 1 ? '' : 's'}.`
        : 'No unused audio to reclaim.');
    },
    onError: (error) => toast.error(errorMessage(error, 'Failed to reclaim unused audio')),
    onSettled: refreshUsage,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteDocumentAudio(documentId),
    onSuccess: (result) => {
      // Drop the reader's cached plan so the next play rebuilds against the
      // cleared storage instead of resuming a deleted timeline.
      clearSegmentCaches();
      const sessions = result.invalidatedPlaybackSessions;
      toast.success(`Deleted ${result.deletedPlaybackObjects} audio object${result.deletedPlaybackObjects === 1 ? '' : 's'}.${
        sessions > 0 ? ` Reset ${sessions} playback session${sessions === 1 ? '' : 's'}.` : ''
      }`);
    },
    onError: (error) => toast.error(errorMessage(error, 'Failed to delete audio')),
    onSettled: refreshUsage,
  });

  const busy = reclaimMutation.isPending || deleteMutation.isPending;
  const usage = usageQuery.data;
  const confirm = () => {
    const action = pendingAction;
    setPendingAction(null);
    if (action === 'reclaim') reclaimMutation.mutate();
    if (action === 'delete') deleteMutation.mutate();
  };

  return (
    <Section title="Storage" variant="group">
      <div className="space-y-1" aria-label="Document storage usage">
        <UsageRow label="Audio for current settings" bytes={usage?.currentAudioBytes} />
        <UsageRow label="Unused audio" bytes={usage?.unusedAudioBytes} />
        <UsageRow label="Document data" bytes={usage?.documentDataBytes} />
      </div>
      {usageQuery.isError ? (
        <p className="text-xs text-danger">{errorMessage(usageQuery.error, 'Failed to load storage usage')}</p>
      ) : null}
      {usage?.truncated ? (
        <p className="text-xs text-soft">Sizes are partial; this document has more stored objects than one scan covers.</p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => setPendingAction('reclaim')}
          disabled={!payload || busy || usage?.unusedAudioBytes === 0}
        >
          {reclaimMutation.isPending ? 'Reclaiming…' : 'Reclaim unused audio'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPendingAction('delete')} disabled={busy}>
          {deleteMutation.isPending ? 'Deleting…' : 'Delete all audio'}
        </Button>
      </div>
      <p className="text-xs text-soft">
        Document data (layout analysis, previews, and reading plans) is shared and reused automatically, so it is kept.
      </p>
      <ConfirmDialog
        isOpen={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        onConfirm={confirm}
        title={pendingAction === 'delete' ? 'Delete all audio?' : 'Reclaim unused audio?'}
        message={pendingAction === 'delete'
          ? 'All generated audio and audiobook exports for this document will be deleted. Playback regenerates audio the next time you press play.'
          : 'Audio generated with other voices or settings, or for older versions of this document, will be deleted. Audio for your current settings is kept.'}
        confirmText={pendingAction === 'delete' ? 'Delete audio' : 'Reclaim'}
        isDangerous={pendingAction === 'delete'}
      />
    </Section>
  );
}
