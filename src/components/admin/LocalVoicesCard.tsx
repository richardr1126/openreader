'use client';

import { useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { formatBytes } from '@/lib/shared/format-bytes';
import { useLocalVoices } from './useLocalVoices';

/**
 * Kokoro, the voice model the compute worker runs itself (on desktop, this
 * device). It downloads on first use; this card fetches it ahead of time, shows
 * the download live, and removes it again.
 */
export function LocalVoicesCard() {
  const onDevice = useRuntimeConfig().installProfile === 'desktop';
  const {
    error,
    isPending,
    busy,
    totalBytes,
    installedBytes,
    installed,
    downloading,
    progress,
    failure: failed,
    start,
    cancel,
    remove: removeModel,
  } = useLocalVoices();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = async () => {
    setConfirmRemove(false);
    await removeModel();
  };
  const where = onDevice ? 'on this device' : 'on the compute worker';

  let state: string;
  if (isPending) state = 'Checking…';
  else if (error) state = error.message;
  else if (downloading) {
    state = progress
      ? `Downloading · ${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}`
      : 'Starting the download…';
  } else if (installed) state = `Downloaded · ${formatBytes(totalBytes)}`;
  else if (installedBytes > 0) state = `Partly downloaded · ${formatBytes(installedBytes)} of ${formatBytes(totalBytes)}`;
  else state = `Not downloaded · about ${formatBytes(totalBytes)}`;

  const percent = progress && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
    : 0;

  return (
    <section aria-labelledby="local-voices-title" className="rounded-lg border border-line-soft bg-surface-solid px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 id="local-voices-title" className="text-sm font-medium text-foreground">Kokoro {where}</h3>
            {installed && !downloading && <Badge tone="accent">Ready</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-soft">
            {onDevice
              ? 'Voices that run on this device with no account or key. They download the first time they speak, or now.'
              : 'Voices the compute worker runs itself with no key. Each worker replica keeps its own copy, downloaded the first time it speaks, or now.'}
          </p>
          <p className="mt-1.5 text-sm text-muted" aria-live="polite">{state}</p>
          {failed && <p className="mt-1 text-sm text-danger">{failed}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {downloading ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
          ) : installed ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</Button>
          ) : (
            <Button size="sm" disabled={busy || isPending || Boolean(error)} onClick={() => void start()}>
              {failed || installedBytes > 0 ? 'Resume download' : 'Download'}
            </Button>
          )}
        </div>
      </div>
      {downloading && (
        <div className="mt-3 space-y-2">
          <div
            role="progressbar"
            aria-label="Kokoro download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-line-soft"
          >
            <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          {progress?.components && (
            <ul className="space-y-0.5 text-xs text-soft">
              {progress.components.map((c) => (
                <li key={c.name} className="flex justify-between gap-3">
                  <span>{c.name}</span>
                  <span className="tabular-nums">
                    {c.state === 'ready' ? 'Done' : c.state === 'verifying' ? 'Verifying…' : `${formatBytes(c.downloadedBytes)} of ${formatBytes(c.totalBytes)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => void remove()}
        title="Remove Kokoro?"
        message={`This deletes ${formatBytes(totalBytes)} of voice data ${where}. Kokoro voices download it again the next time they speak.`}
        confirmText="Remove"
        isDangerous
      />
    </section>
  );
}
