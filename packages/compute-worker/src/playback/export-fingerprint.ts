import { createHash } from 'node:crypto';

/**
 * Identifies the audio an audiobook is built from, in plan order: each
 * segment's audio object and duration (which sets M4B chapter boundaries), or
 * silence for a skipped one. The export job records it on the file it builds;
 * export progress reports it for the current sources, so a file built from
 * other audio (a repaired reparse, a retried skip, a probed duration) is never
 * offered as ready.
 */
export function exportSourceFingerprint(
  ordinals: Iterable<number>,
  audioOf: (ordinal: number) => { audioKey: string; durationMs: number } | null,
): string {
  const hash = createHash('sha256');
  for (const ordinal of ordinals) {
    const audio = audioOf(ordinal);
    hash.update(audio ? `${ordinal}\0a\0${audio.audioKey}\0${audio.durationMs}\n` : `${ordinal}\0s\n`);
  }
  return hash.digest('hex');
}
