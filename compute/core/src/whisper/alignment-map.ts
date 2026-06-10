import type { TTSSentenceAlignment, TTSSentenceWord } from '../types/tts';

// Worker-side mirror of the app's canonical audio-text cleaning rules in
// `src/lib/shared/audio-text.ts`. This is a separate build target and cannot
// import from `@/lib`, so the rules are duplicated here on purpose. The word
// `charStart`/`charEnd` offsets this module emits are consumed against text
// normalized by that shared module, so any divergence shifts viewer highlights
// off-word — keep this byte-for-byte in sync with `audio-text.ts`.
const STRIPPED_GLYPHS = /[*•◦‣⁃∙▪▫■□●○◆◇★☆▶▸►▹➤➢❖]/g;

function preprocessSentenceForAudio(text: string): string {
  return text
    .replace(/\S*(?:https?:\/\/|www\.)([^\/\s]+)(?:\/\S*)?/gi, '- (link to $1) -')
    .replace(/([\p{L}\p{N}\p{M}]+)-\s+([\p{L}\p{N}\p{M}]+)/gu, '$1$2')
    .replace(STRIPPED_GLYPHS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WhisperWord {
  start: number;
  end: number;
  word: string;
}

export function mapWordsToSentenceOffsets(sentence: string, words: WhisperWord[]): TTSSentenceAlignment {
  const normalizedSentence = preprocessSentenceForAudio(sentence);
  const lowerSentence = normalizedSentence.toLowerCase();
  let cursor = 0;

  const alignedWords: TTSSentenceWord[] = words.map((w) => {
    const token = w.word.trim();
    if (!token) {
      return {
        text: '',
        startSec: w.start,
        endSec: w.end,
        charStart: cursor,
        charEnd: cursor,
      };
    }

    const idx = lowerSentence.indexOf(token.toLowerCase(), cursor);
    const start = idx >= 0 ? idx : cursor;
    const end = Math.min(normalizedSentence.length, start + token.length);
    cursor = Math.max(cursor, end);

    return {
      text: token,
      startSec: w.start,
      endSec: w.end,
      charStart: start,
      charEnd: end,
    };
  }).filter((word) => word.text.length > 0);

  return {
    sentence,
    sentenceIndex: 0,
    words: alignedWords,
  };
}
