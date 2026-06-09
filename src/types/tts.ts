import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';
export type {
  TTSAudioBuffer,
  TTSAudioBytes,
  TTSSentenceAlignment,
  TTSSentenceWord,
} from '@openreader/compute-core/types';

export type TTSLocation = string | number;

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


interface EpubRenderedLocationWalkItem {
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
  /**
   * Canonical segments for this chunk, windowed from the chapter's canonical
   * plan and attached after the raw walk. Present → prefetch uses
   * viewport-independent segments with identical keys to playback; absent →
   * preview-based fallback planning.
   */
  segments?: CanonicalTtsSegment[];
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
