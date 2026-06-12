export type TTSAudioBuffer = ArrayBuffer;
export type TTSAudioBytes = number[];

export interface TTSSentenceWord {
  text: string;
  startSec: number;
  endSec: number;
  charStart: number;
  charEnd: number;
}

export interface TTSSentenceAlignment {
  sentence: string;
  sentenceIndex: number;
  words: TTSSentenceWord[];
}
