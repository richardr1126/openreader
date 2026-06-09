import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';
import type { TTSSentenceWord } from '@/types/tts';

/**
 * Resolve a spoken word's char offsets (from the Whisper alignment) into the
 * canonical source-offset space the rendered text map is keyed by. The
 * alignment's `charStart`/`charEnd` are offsets into the segment text, which is
 * in the same normalized space as `segment.startAnchor.offset`.
 */
export const resolveAlignmentWordSourceRange = (
  segment: CanonicalTtsSegment,
  word: TTSSentenceWord,
): { sourceStart: number; sourceEnd: number } | null => {
  const { charStart, charEnd } = word;
  if (!Number.isInteger(charStart) || !Number.isInteger(charEnd)) return null;
  if (charStart < 0 || charEnd <= charStart || charEnd > segment.text.length) return null;

  return {
    sourceStart: segment.startAnchor.offset + charStart,
    sourceEnd: segment.startAnchor.offset + charEnd,
  };
};
