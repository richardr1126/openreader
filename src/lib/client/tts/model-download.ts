import type { TtsPlaybackEventSnapshot } from '@/lib/client/api/tts';
import { formatBytes } from '@/lib/shared/format-bytes';

/** A model the worker is downloading for this playback, shown as a progress popup. */
export type PlaybackModelDownload = {
  label: string;
  statusMessage: string;
  progress: number | null;
};

export function describeModelDownload(snapshot: TtsPlaybackEventSnapshot): PlaybackModelDownload | null {
  if (snapshot.status === 'failed' || snapshot.status === 'succeeded') return null;
  if (snapshot.phase !== 'downloading_model') return null;
  const { downloadedBytes, totalBytes } = snapshot;
  const progress = totalBytes && downloadedBytes !== null
    ? Math.min(100, (downloadedBytes / totalBytes) * 100)
    : null;
  if (progress !== null && progress >= 100) return null;
  const bytes = totalBytes && downloadedBytes !== null
    ? `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`
    : 'Starting…';
  // Only the local voice model reports its parts.
  const label = snapshot.modelComponents ? 'Downloading voices' : 'Downloading word timing model';
  return { label, statusMessage: bytes, progress };
}
