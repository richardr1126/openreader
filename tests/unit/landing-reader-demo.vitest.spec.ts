import { describe, expect, it } from 'vitest';
import {
  findActiveDemoWord,
  formatDemoTime,
  splitDemoSentence,
} from '@/app/(public)/reader-demo-timeline';
import type { TTSSentenceAlignment } from '@/types/tts';

const sentences: TTSSentenceAlignment[] = [
  {
    sentenceIndex: 0,
    sentence: 'Dorothy lived here.',
    words: [
      { text: 'Dorothy', startSec: 0.2, endSec: 0.6, charStart: 0, charEnd: 7 },
      { text: 'lived', startSec: 0.7, endSec: 1.0, charStart: 8, charEnd: 13 },
      { text: 'here.', startSec: 1.0, endSec: 1.4, charStart: 14, charEnd: 19 },
    ],
  },
  {
    sentenceIndex: 1,
    sentence: 'It was small.',
    words: [
      { text: 'It', startSec: 2.0, endSec: 2.1, charStart: 0, charEnd: 2 },
      { text: 'was', startSec: 2.1, endSec: 2.3, charStart: 3, charEnd: 6 },
      { text: 'small.', startSec: 2.3, endSec: 2.9, charStart: 7, charEnd: 13 },
    ],
  },
];

describe('landing reader demo timeline', () => {
  it('follows the audio clock word by word across sentences', () => {
    expect(findActiveDemoWord(sentences, 0)).toBeNull();
    expect(findActiveDemoWord(sentences, 0.3)).toEqual({ sentence: 0, word: 0 });
    expect(findActiveDemoWord(sentences, 0.65)).toEqual({ sentence: 0, word: 0 });
    expect(findActiveDemoWord(sentences, 1.0)).toEqual({ sentence: 0, word: 2 });
    expect(findActiveDemoWord(sentences, 1.7)).toEqual({ sentence: 0, word: 2 });
    expect(findActiveDemoWord(sentences, 2.2)).toEqual({ sentence: 1, word: 1 });
    // The final word holds until the clip ends and the player resets.
    expect(findActiveDemoWord(sentences, 3.5)).toEqual({ sentence: 1, word: 2 });
  });

  it('splits a sentence into spoken words and the text between them', () => {
    expect(splitDemoSentence(sentences[0])).toEqual([
      { text: 'Dorothy', word: 0 },
      { text: ' ', word: null },
      { text: 'lived', word: 1 },
      { text: ' ', word: null },
      { text: 'here.', word: 2 },
    ]);
  });

  it('keeps text whose words lack usable offsets', () => {
    const parts = splitDemoSentence({
      sentenceIndex: 0,
      sentence: 'Uncle Henry.',
      words: [
        { text: 'Uncle', startSec: 0, endSec: 0.3 },
        { text: 'Henry.', startSec: 0.3, endSec: 0.8, charStart: 6, charEnd: 12 },
      ],
    });
    expect(parts.map((part) => part.text).join('')).toBe('Uncle Henry.');
    expect(parts).toContainEqual({ text: 'Henry.', word: 1 });
  });

  it('formats clip time as minutes and seconds', () => {
    expect(formatDemoTime(0)).toBe('00:00');
    expect(formatDemoTime(19.8)).toBe('00:19');
    expect(formatDemoTime(75)).toBe('01:15');
  });
});
