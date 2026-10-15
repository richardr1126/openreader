'use client';

import Link from 'next/link';
import { Transition } from '@headlessui/react';
import { IconButton } from '@/components/ui';
import type { useLocalVoices } from '@/components/admin/useLocalVoices';
import { formatBytes } from '@/lib/shared/format-bytes';

const actionClass = 'inline-flex h-7 shrink-0 items-center rounded-md border border-accent-line bg-surface px-2.5 text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-background disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * Desktop first run: the shell seeds a Kokoro provider, whose voices download
 * the first time they speak. This strip offers that download up front, with
 * live progress, or a voice service instead. Reading never waits on it.
 */
export function LocalVoicesBanner({
  show,
  voices,
  onDismiss,
}: {
  show: boolean;
  voices: ReturnType<typeof useLocalVoices>;
  onDismiss: () => void;
}) {
  const { busy, totalBytes, installedBytes, downloading, progress, failure, start, cancel } = voices;
  const percent = progress && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
    : 0;

  let detail: string;
  if (downloading) {
    detail = progress
      ? `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}`
      : 'Starting…';
  } else if (failure) detail = failure;
  else detail = `Kokoro runs on this device · about ${formatBytes(totalBytes)}`;

  return (
    <Transition
      show={show}
      appear
      as="div"
      className="grid shrink-0 transition-[grid-template-rows,opacity] duration-slow ease-standard"
      enterFrom="grid-rows-[0fr] opacity-0"
      enterTo="grid-rows-[1fr] opacity-100"
      leaveFrom="grid-rows-[1fr] opacity-100"
      leaveTo="grid-rows-[0fr] opacity-0"
    >
      <div className="min-h-0 overflow-hidden">
        <aside
          aria-label="Voices"
          className="relative flex items-center gap-2.5 border-b border-line-soft bg-accent-wash px-3 py-1.5 sm:gap-3"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-accent-line bg-surface text-accent" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
              <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" strokeLinecap="round" />
            </svg>
          </span>
          <p className="min-w-0 flex-1 truncate text-[13px] leading-tight text-foreground" aria-live="polite">
            <span className="font-semibold">{downloading ? 'Downloading voices' : 'Download voices to start listening'}</span>
            <span className={failure && !downloading ? 'text-danger' : 'hidden text-soft sm:inline'}>
              {' · '}{detail}
            </span>
          </p>
          {downloading ? (
            <button type="button" className={actionClass} disabled={busy} onClick={() => void cancel()}>Cancel</button>
          ) : (
            <>
              <Link href="/app/settings?section=providers" className="hidden shrink-0 text-xs text-soft underline-offset-2 hover:text-foreground hover:underline md:inline">
                Use a voice service instead
              </Link>
              <button type="button" className={actionClass} disabled={busy} onClick={() => void start()}>
                {failure ? 'Try again' : installedBytes > 0 ? 'Resume' : 'Download'}
              </button>
            </>
          )}
          <IconButton onClick={onDismiss} size="sm" aria-label="Dismiss voices banner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </IconButton>
          {downloading && (
            <div
              role="progressbar"
              aria-label="Voice download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="absolute inset-x-0 bottom-0 h-0.5 bg-line-soft"
            >
              <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
            </div>
          )}
        </aside>
      </div>
    </Transition>
  );
}
