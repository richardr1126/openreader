import type { TTSSentenceAlignment } from '@/types/tts';

/**
 * A pre-rendered read-along clip for the landing page. The audio and word
 * timings are exported once from a real OpenReader playback cache and served
 * as static files, so the demo needs no session, worker, or storage.
 *
 * `sentences` uses the worker's alignment shape, except that `startSec` and
 * `endSec` are absolute offsets into the single concatenated `audioSrc` file
 * rather than per-segment offsets. `charStart`/`charEnd` index into each
 * sentence's own text.
 */
export interface ReaderDemo {
  audioSrc: string;
  fileName: string;
  chapter: string;
  voiceLabel: string;
  durationSec: number;
  sentences: TTSSentenceAlignment[];
}

export interface ActiveDemoWord {
  sentence: number;
  word: number;
}

/**
 * The word being spoken at `timeSec`. Between words the previous word stays
 * highlighted, matching the app's reader. Nothing is active before the first
 * word; the last word holds until the clip ends and the player resets.
 */
export function findActiveDemoWord(
  sentences: readonly TTSSentenceAlignment[],
  timeSec: number,
): ActiveDemoWord | null {
  let active: ActiveDemoWord | null = null;
  for (let s = 0; s < sentences.length; s += 1) {
    const { words } = sentences[s];
    for (let w = 0; w < words.length; w += 1) {
      if (words[w].startSec > timeSec) return active;
      active = { sentence: s, word: w };
    }
  }
  return active;
}

export interface DemoTextPart {
  text: string;
  /** Index into the sentence's `words`, or null for text between words. */
  word: number | null;
}

/** Splits a sentence into plain text and spoken-word parts by char offsets. */
export function splitDemoSentence(alignment: TTSSentenceAlignment): DemoTextPart[] {
  const { sentence, words } = alignment;
  const parts: DemoTextPart[] = [];
  let cursor = 0;
  words.forEach((word, index) => {
    const start = word.charStart;
    const end = word.charEnd;
    if (start === undefined || end === undefined || end <= start || start < cursor) return;
    if (start > cursor) parts.push({ text: sentence.slice(cursor, start), word: null });
    parts.push({ text: sentence.slice(start, end), word: index });
    cursor = end;
  });
  if (cursor < sentence.length) parts.push({ text: sentence.slice(cursor), word: null });
  return parts;
}

export function formatDemoTime(totalSec: number): string {
  const whole = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
