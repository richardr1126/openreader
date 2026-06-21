import type {
  TTSAudiobookChapter,
  TTSAudiobookFormat,
} from '@/types/tts';
import type { TtsProviderType } from '@openreader/tts/provider-catalog';
import type {
  TTSSegmentLocator,
  TTSSegmentSettings,
  TTSSentenceAlignment,
} from '@openreader/tts/types';
export type {
  TTSSegmentLocator,
  TTSSegmentSettings,
  TTSReaderType,
} from '@openreader/tts/types';
export {
  isHtmlLocator,
  isPdfLocator,
  isStableEpubLocator,
} from '@openreader/tts/types';

// --- TTS Client Request Types ---

// Headers used when calling TTS-related endpoints from the client.
export type TTSRequestHeaders = Record<string, string>;

// Options for retrying TTS requests on failure in withRetry
export interface TTSRetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

export interface TTSRequestError extends Error {
  status?: number;
  code?: string;
  type?: string;
  title?: string;
  detail?: string;
}

// --- Audiobook API Types ---

export interface AudiobookStatusResponse {
  exists: boolean;
  chapters: TTSAudiobookChapter[];
  bookId: string | null;
  hasComplete: boolean;
  settings?: AudiobookGenerationSettings | null;
}

export type ClaimableCounts = {
  documents: number;
  audiobooks: number;
  preferences: number;
  progress: number;
  documentSettings: number;
  folders: number;
  onboarding: number;
};

export interface AudiobookGenerationSettings {
  providerRef: string;
  providerType: TtsProviderType;
  ttsModel: string;
  voice: string;
  nativeSpeed: number;
  postSpeed: number;
  format: TTSAudiobookFormat;
  ttsInstructions?: string;
  language?: string;
}

export interface CreateChapterPayload {
  chapterTitle: string;
  text: string;
  bookId: string;
  format: TTSAudiobookFormat;
  chapterIndex: number;
  settings?: AudiobookGenerationSettings;
}

export interface VoicesResponse {
  voices: string[];
}

export interface TTSSegmentVariant {
  segmentId: string;
  settings: TTSSegmentSettings | null;
  audioPresignUrl: string | null;
  audioFallbackUrl: string | null;
  durationMs: number | null;
  status: 'pending' | 'completed' | 'error';
  textLength: number;
  alignmentWordCount: number;
  audioKey: string | null;
  updatedAt: number | null;
}

export interface TTSSegmentRow {
  segmentIndex: number;
  /**
   * Content-stable identity for this segment, derived from the normalized
   * sentence text on the client (see `buildSegmentKey` in
   * `lib/shared/tts-segment-plan.ts`). The sidebar uses this to merge
   * locally-synthesized current-page rows with persisted manifest rows of the
   * same content, so audio/variants attach to the visible text row instead of
   * showing as a separate listing.
   */
  segmentKey: string | null;
  locator: TTSSegmentLocator | null;
  variants: TTSSegmentVariant[];
}

export interface TTSSegmentsManifestResponse {
  documentId: string;
  segments: TTSSegmentRow[];
  nextCursor: string | null;
  hasMore: boolean;
}
