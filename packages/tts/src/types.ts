import type { TtsProviderType } from './provider-catalog';

export type ReaderType = 'pdf' | 'epub' | 'html';

export type TTSLocation = string | number;

export type TTSReaderType = ReaderType;

export interface TTSSegmentLocator {
  readerType?: TTSReaderType;
  page?: number;
  blockId?: string;
  location?: string;
  spineHref?: string;
  spineIndex?: number;
  charOffset?: number;
  cfi?: string;
}

export interface TTSSegmentSettings {
  providerRef: string;
  providerType: TtsProviderType;
  ttsModel: string;
  voice: string;
  nativeSpeed: number;
  ttsInstructions?: string;
  language?: string;
}

export interface TTSSentenceWord {
  text: string;
  startSec: number;
  endSec: number;
  charStart?: number;
  charEnd?: number;
}

export interface TTSSentenceAlignment {
  sentenceIndex: number;
  sentence: string;
  words: TTSSentenceWord[];
}

export function isPdfLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & { readerType: 'pdf'; page: number } {
  return locator?.readerType === 'pdf' && typeof locator.page === 'number' && Number.isFinite(locator.page);
}

export function isHtmlLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & { readerType: 'html'; location: string } {
  return locator?.readerType === 'html' && typeof locator.location === 'string' && locator.location.length > 0;
}

export function isStableEpubLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & { readerType: 'epub'; spineHref: string; spineIndex: number; charOffset: number } {
  return locator?.readerType === 'epub'
    && typeof locator.spineHref === 'string'
    && locator.spineHref.length > 0
    && typeof locator.spineIndex === 'number'
    && Number.isFinite(locator.spineIndex)
    && typeof locator.charOffset === 'number'
    && Number.isFinite(locator.charOffset);
}
