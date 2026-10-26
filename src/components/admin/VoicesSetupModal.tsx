'use client';

import { Button, ModalFrame, ModalTitle } from '@/components/ui';
import { formatBytes } from '@/lib/shared/format-bytes';
import type { useLocalVoices } from './useLocalVoices';

/**
 * Desktop onboarding step: a fresh install has no usable voice until Kokoro is
 * downloaded or a voice service is added, so the owner picks one before
 * continuing. The download can keep running after the step closes; playback
 * joins it.
 */
export function VoicesSetupModal({
  isOpen,
  voices,
  onContinue,
  onUseService,
  onAfterLeave,
}: {
  isOpen: boolean;
  voices: ReturnType<typeof useLocalVoices>;
  onContinue: () => void;
  onUseService: () => void;
  onAfterLeave: () => void;
}) {
  const { busy, totalBytes, installedBytes, installed, downloading, progress, failure, start, cancel } = voices;
  const percent = progress && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
    : 0;

  return (
    <ModalFrame
      open={isOpen}
      onClose={() => {}}
      afterLeave={onAfterLeave}
      panelTestId="voices-setup-modal"
      className="z-[80]"
    >
      <ModalTitle>Choose how OpenReader speaks</ModalTitle>

      {installed ? (
        <div className="mt-5 rounded-lg border border-accent-line bg-accent-wash p-3 text-sm text-foreground" aria-live="polite">
          Voices are ready on this device.
        </div>
      ) : downloading ? (
        <div className="mt-5 space-y-2 rounded-lg border border-line bg-surface-sunken p-3" aria-live="polite">
          <div className="flex justify-between gap-3 text-sm">
            <span className="font-medium text-foreground">Downloading Kokoro voices</span>
            <span className="tabular-nums text-soft">
              {progress ? `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}` : 'Starting…'}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Voice download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-line-soft"
          >
            <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <section className="flex flex-col rounded-lg border border-line bg-surface-sunken p-3">
            <h4 className="text-sm font-semibold text-foreground">Voices on this device</h4>
            <p className="mt-1 flex-1 text-xs text-soft">
              Kokoro: free, private and offline once downloaded. About {formatBytes(totalBytes)}.
            </p>
            {failure && <p className="mt-2 text-xs text-danger">{failure}</p>}
            <Button className="mt-3" variant="primary" disabled={busy} onClick={() => void start()}>
              {failure || installedBytes > 0 ? 'Resume download' : 'Download voices'}
            </Button>
          </section>
          <section className="flex flex-col rounded-lg border border-line bg-surface-sunken p-3">
            <h4 className="text-sm font-semibold text-foreground">A voice service</h4>
            <p className="mt-1 flex-1 text-xs text-soft">
              OpenAI, Google AI Studio, Replicate, or a speech server you run. Needs a key or address.
            </p>
            <Button className="mt-3" onClick={onUseService}>Set up a service</Button>
          </section>
        </div>
      )}

      {(installed || downloading) && (
        <div className="mt-6 flex justify-end gap-2">
          {downloading && (
            <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel download</Button>
          )}
          <Button variant="primary" onClick={onContinue}>
            {installed ? 'Start reading' : 'Continue while it downloads'}
          </Button>
        </div>
      )}
    </ModalFrame>
  );
}
