import type { TTSSentenceAlignment, TTSSentenceWord } from '../types/tts';

function preprocessSentenceForAudio(text: string): string {
  return text
    .replace(/\S*(?:https?:\/\/|www\.)([^\/\s]+)(?:\/\S*)?/gi, '- (link to $1) -')
    .replace(/(\w+)-\s+(\w+)/g, '$1$2')
    .replace(/\*/g, '')
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
