/**
 * Format a playback position without allowing minutes to grow indefinitely.
 *
 * Examples: 4:05, 1:04:05, 2d 01:04:05.
 */
export function formatPlaybackTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;

  const mm = minutes.toString().padStart(2, '0');
  const ss = remainingSeconds.toString().padStart(2, '0');

  if (days > 0) {
    return `${days}d ${hours.toString().padStart(2, '0')}:${mm}:${ss}`;
  }

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }

  return `${minutes}:${ss}`;
}
