'use client';

import { useState } from 'react';
import { Badge, Button, InlineButton, Switch } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ProviderLogo, PROVIDER_BRANDS } from '@/components/providers/provider-brands';
import { formatBytes } from '@/lib/shared/format-bytes';
import { useLocalVoices } from './useLocalVoices';

/**
 * Kokoro, the voice model the compute worker runs itself (on desktop, this
 * device). The switch offers it to users through its shared provider row; the
 * download happens on first use, or ahead of time from here.
 */
export function LocalModelCard({
  where,
  offered,
  isDefault,
  busy: providerBusy,
  onOfferChange,
  onSetDefault,
}: {
  where: string;
  offered: boolean;
  isDefault: boolean;
  busy: boolean;
  onOfferChange: (offered: boolean) => void;
  onSetDefault: () => void;
}) {
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
  const brand = PROVIDER_BRANDS['kokoro-local'];

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
    <section aria-labelledby="local-model-kokoro" className="flex items-start gap-3">
      <ProviderLogo providerType="kokoro-local" size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h4 id="local-model-kokoro" className={`truncate text-sm font-medium ${offered ? 'text-foreground' : 'text-soft'}`}>{brand.name}</h4>
          {isDefault && offered && <Badge tone="accent">Default</Badge>}
          {installed && !downloading && <Badge tone="muted">Ready</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-soft">{brand.summary}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-sm text-muted" aria-live="polite">{state}</span>
          {downloading ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
          ) : installed ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy || isPending || Boolean(error)} onClick={() => void start()}>
              {failed || installedBytes > 0 ? 'Resume download' : 'Download'}
            </Button>
          )}
          {offered && !isDefault && (
            <InlineButton onClick={onSetDefault} disabled={providerBusy} className="text-xs text-soft no-underline hover:text-accent">
              Set as default
            </InlineButton>
          )}
        </div>
        {failed && <p className="mt-1 text-sm text-danger">{failed}</p>}
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
      </div>
      <Switch
        checked={offered}
        onChange={onOfferChange}
        disabled={providerBusy}
        ariaLabel={`Offer ${brand.name} to users`}
        className="mt-0.5"
      />
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
