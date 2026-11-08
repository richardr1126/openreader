'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button, Tooltip } from '@/components/ui';
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

type StorageCategory = 'documents' | 'audio' | 'orphaned';

// Each mark uses theme tokens so the bar follows the reader's theme. Foreground
// stays clear of the accent in every theme, and the hatch never relies on color.
const CATEGORY_FILL: Record<StorageCategory, { className: string; style?: CSSProperties }> = {
  documents: { className: 'bg-accent' },
  audio: { className: 'bg-foreground' },
  orphaned: {
    className: 'bg-muted',
    style: { backgroundImage: 'repeating-linear-gradient(135deg, var(--foreground) 0 2px, transparent 2px 5px)' },
  },
};

function UsageRow({
  category,
  label,
  bytes,
  detail,
  action,
}: {
  category: StorageCategory;
  label: string;
  bytes: number | undefined;
  detail?: string;
  action?: ReactNode;
}) {
  const fill = CATEGORY_FILL[category];
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded-sm ${fill.className}`} style={fill.style} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {detail ? <div className="mt-0.5 text-xs text-faint">{detail}</div> : null}
      </div>
      <span className="text-sm font-medium tabular-nums text-foreground">{bytes === undefined ? '—' : formatBytes(bytes)}</span>
      <div className="w-24 shrink-0 text-right">{action}</div>
    </div>
  );
}

function StorageBar({ segments, total, cap }: {
  segments: { category: StorageCategory; label: string; bytes: number }[];
  total: number;
  cap: number | null;
}) {
  const scale = Math.max(total, cap ?? 0, 1);
  // Over the limit the bar scales to usage, so this marks where the limit falls.
  const limitPosition = cap !== null && total > cap ? (cap / total) * 100 : null;
  const summary = segments.map((segment) => `${segment.label} ${formatBytes(segment.bytes)}`).join(', ');
  return (
    <div
      role="img"
      aria-label={`Storage used: ${formatBytes(total)}${cap === null ? '' : ` of ${formatBytes(cap)}`}${summary ? `. ${summary}` : ''}`}
      className="relative"
    >
      <div className="flex h-4 gap-0.5 overflow-hidden rounded-md bg-offbase">
        {segments.filter((segment) => segment.bytes > 0).map((segment) => {
          const fill = CATEGORY_FILL[segment.category];
          return (
            <Tooltip key={segment.category} label={`${segment.label}: ${formatBytes(segment.bytes)}`}>
              <div
                className={`h-full min-w-1 transition-[width] duration-slow ${fill.className}`}
                style={{ ...fill.style, width: `${(segment.bytes / scale) * 100}%` }}
              />
            </Tooltip>
          );
        })}
      </div>
      {limitPosition === null ? null : (
        <div
          className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground ring-2 ring-surface-solid"
          style={{ left: `${limitPosition}%` }}
        />
      )}
    </div>
  );
}

function StorageSkeleton() {
  return (
    <div className={`animate-pulse ${CARD_CLASS}`} aria-label="Loading storage usage" aria-busy="true">
      <div className="space-y-3 p-4">
        <div className="h-3 w-24 rounded bg-offbase" />
        <div className="h-8 w-40 rounded bg-offbase" />
        <div className="h-4 rounded-md bg-offbase" />
      </div>
      {[false, true, true].map((hasAction, index) => (
        <div key={index} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <div className="h-3 w-3 shrink-0 rounded-sm bg-offbase" />
          <div className="h-4 w-28 flex-1 rounded bg-offbase" />
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
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage(sessionKey) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.computeLimits(sessionKey) }),
    ]),
  });

  const usage = usageQuery.data;
  const capBytes = usage?.capBytes ?? null;
  const busyTarget = reclaimMutation.isPending ? reclaimMutation.variables : null;
  const pendingCopy = pendingTarget ? CONFIRM_COPY[pendingTarget] : null;

  return (
    <section className="space-y-3" aria-label="Library storage">
      {usageQuery.isPending ? <StorageSkeleton /> : (
        <div className={CARD_CLASS}>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
              <div className="min-w-0">
                <h3 className="text-xs font-medium text-soft">Total storage</h3>
                <p className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">{usage ? formatBytes(usage.totalBytes) : '—'}</span>
                  {capBytes === null ? null : <span className="text-sm tabular-nums text-soft">of {formatBytes(capBytes)}</span>}
                </p>
              </div>
              {usage ? (
                <p className={`text-sm tabular-nums ${capBytes !== null && usage.totalBytes >= capBytes ? 'font-medium text-danger' : 'text-soft'}`}>
                  {capBytes === null ? 'No limit' : usage.totalBytes > capBytes
                    ? `${formatBytes(usage.totalBytes - capBytes)} over limit`
                    : usage.totalBytes === capBytes ? 'Limit reached' : `${formatBytes(capBytes - usage.totalBytes)} available`}
                </p>
              ) : null}
            </div>
            <StorageBar
              total={usage?.totalBytes ?? 0}
              cap={capBytes}
              segments={usage ? [
                { category: 'documents', label: 'Documents', bytes: usage.documentBytes },
                { category: 'audio', label: 'Audio', bytes: usage.audioBytes - usage.orphanedAudioBytes },
                { category: 'orphaned', label: 'Orphaned audio', bytes: usage.orphanedAudioBytes },
              ] : []}
            />
          </div>
          <UsageRow
            category="documents"
            label="Documents"
            bytes={usage?.documentBytes}
            detail={usage ? plural(usage.documentCount, 'document') : undefined}
          />
          <UsageRow
            category="audio"
            label="Audio"
            bytes={usage ? usage.audioBytes - usage.orphanedAudioBytes : undefined}
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
            category="orphaned"
            label="Orphaned audio"
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
