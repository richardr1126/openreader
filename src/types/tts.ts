import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';

export type TTSLocation = string | number;

// Core audio representations used across TTS and audiobook flows
export type TTSAudioBuffer = ArrayBuffer;
export type TTSAudioBytes = number[]; // JSON-safe representation (Array.from(new Uint8Array(buffer)))

// Standardized error codes for the TTS API
export type TTSErrorCode =
  | 'MISSING_PARAMETERS'
  | 'INVALID_REQUEST'
  | 'TTS_GENERATION_FAILED'
  | 'ABORTED'
  | 'INTERNAL_ERROR';

// Structured error object returned by the TTS API
export interface TTSError {
  code: TTSErrorCode;
  message: string;
  details?: unknown;
}

// Core playback state exposed by the TTS context
export interface TTSPlaybackState {
  isPlaying: boolean;
  isProcessing: boolean;
  currentSentence: string;
  currentSegment?: CanonicalTtsSegment | null;
  currDocPage: TTSLocation;
  currDocPageNumber: number;
  currDocPages?: number;
}

// Estimate for when a visual page/section turn should occur during audio playback
export interface TTSPageTurnEstimate {
  location: TTSLocation;
  sentenceIndex: number;
  fraction: number;
}

// Word-level alignment within a single spoken sentence/block
export interface TTSSentenceWord {
  text: string;
  startSec: number;
  endSec: number;
  charStart: number;
  charEnd: number;
}

// Alignment metadata for a single TTS sentence/block
export interface TTSSentenceAlignment {
  sentence: string;
  sentenceIndex: number;
  words: TTSSentenceWord[];
}

export interface EpubRenderedLocationWalkItem {
  /** Page-start CFI from the rendition — best-effort jump hint only. */
  cfi: string;
  /** Plain text content of the rendered page chunk. */
  text: string;
  /** Spine item href the chunk belongs to (stable across viewports). */
  spineHref: string;
  /** Ordinal of the spine item within the book (stable across viewports). */
  spineIndex: number;
  /**
   * Offset (in normalized character space) of this chunk's start inside the
   * spine item's plain text. Stable across viewports.
   */
  chunkOffset: number;
}

export type EpubRenderedLocationWalker = (
  startCfi: string,
  depth: number,
  signal: AbortSignal,
) => Promise<EpubRenderedLocationWalkItem[]>;

// Supported output formats for generated audiobooks
export type TTSAudiobookFormat = 'mp3' | 'm4b';

// Metadata for an audiobook chapter
export interface TTSAudiobookChapter {
  index: number;
  title: string;
  duration?: number;
  status: 'pending' | 'generating' | 'completed' | 'error';
  bookId?: string;
  format?: TTSAudiobookFormat;
}
