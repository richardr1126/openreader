import type {
  TTSAudiobookChapter,
  TTSAudiobookFormat,
  TTSSentenceAlignment,
} from '@/types/tts';
import type { TtsProviderType } from '@/lib/shared/tts-provider-catalog';

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


// --- TTS Voices API Types ---

export interface VoicesResponse {
  voices: string[];
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

type TTSReaderType = 'pdf' | 'epub' | 'html';

/**
 * Locator describing where a TTS segment came from inside a document.
 *
 * Field usage by readerType:
 *  - PDF:  `page` (1-based).
 *  - HTML: `location` (free-form fragment id / scroll anchor).
 *  - EPUB: **stable book coordinates** — `spineHref`, `spineIndex`, `charOffset`.
 *          `cfi` is a best-effort jump hint only; it is NOT used for identity,
 *          grouping, sorting, or matching. The stable coordinates are the same
 *          across devices and window sizes.
 *
 * The interface is structurally permissive for backwards compatibility with
 * in-flight code paths, but the server-side `normalizeLocator` enforces the
 * required fields per readerType before persisting. Use the
 * `isStableEpubLocator` / `isPdfLocator` / `isHtmlLocator` guards at read sites
 * that need a particular shape.
 */
export interface TTSSegmentLocator {
  readerType?: TTSReaderType;
  // PDF / legacy
  page?: number;
  // PDF block-level locator (structured parser path)
  blockId?: string;
  // HTML / legacy EPUB CFI (kept for in-flight drafts; not persisted for EPUB)
  location?: string;
  // Stable EPUB coordinates
  spineHref?: string;
  spineIndex?: number;
  charOffset?: number;
  /** Best-effort jump hint for EPUB; not part of identity/sort/group. */
  cfi?: string;
}

export function isPdfLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & { readerType: 'pdf'; page: number } {
  return !!locator
    && locator.readerType === 'pdf'
    && typeof locator.page === 'number'
    && Number.isFinite(locator.page);
}

export function isHtmlLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & { readerType: 'html'; location: string } {
  return !!locator
    && locator.readerType === 'html'
    && typeof locator.location === 'string'
    && locator.location.length > 0;
}

/**
 * Narrow to a fully-stable EPUB locator. Returns false for EPUB drafts that
 * only carry a CFI — those must be resolved to spine coordinates before being
 * sent to the server.
 */
export function isStableEpubLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & {
  readerType: 'epub';
  spineHref: string;
  spineIndex: number;
  charOffset: number;
} {
  return !!locator
    && locator.readerType === 'epub'
    && typeof locator.spineHref === 'string'
    && locator.spineHref.length > 0
    && typeof locator.spineIndex === 'number'
    && Number.isFinite(locator.spineIndex)
    && typeof locator.charOffset === 'number'
    && Number.isFinite(locator.charOffset);
}

export interface TTSSegmentInput {
  segmentIndex: number;
  segmentKey?: string;
  text: string;
  locator?: TTSSegmentLocator;
}

export interface TTSSegmentsEnsureRequest {
  documentId: string;
  segments: TTSSegmentInput[];
  settings: TTSSegmentSettings;
}

export interface TTSSegmentManifestItem {
  segmentId: string;
  segmentIndex: number;
  segmentKey?: string | null;
  audioPresignUrl: string | null;
  audioFallbackUrl: string | null;
  durationMs: number;
  alignment: TTSSentenceAlignment | null;
  locator: TTSSegmentLocator | null;
  status: 'pending' | 'completed' | 'error';
  error?: {
    code: string;
    detail?: string;
    upstreamStatus?: number;
    retryAfterSeconds?: number;
  } | null;
}

export interface TTSSegmentsEnsureResponse {
  documentId: string;
  segments: TTSSegmentManifestItem[];
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
