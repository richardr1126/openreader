import type {
  TTSAudiobookChapter,
  TTSSentenceAlignment,
  TTSAudioBytes,
  TTSAudiobookFormat,
} from '@/types/tts';

// --- TTS Client Request Types ---

// Supported output formats for the TTS endpoint
export type TTSRequestFormat = 'mp3';

// JSON payload accepted by the /api/tts endpoint
export interface TTSRequestPayload {
  text: string;
  voice: string;
  speed: number;
  model?: string | null;
  format?: TTSRequestFormat;
  instructions?: string;
}

// Headers used when calling the /api/tts endpoint from the client
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
  ttsProvider: string;
  ttsModel: string;
  voice: string;
  nativeSpeed: number;
  postSpeed: number;
  format: TTSAudiobookFormat;
  ttsInstructions?: string;
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

// --- Whisper API Types ---

export interface AlignmentPayload {
  text: string;
  audio: TTSAudioBytes; // Array.from(new Uint8Array(arrayBuffer))
}

export interface AlignmentResponse {
  alignments: TTSSentenceAlignment[];
}

export interface TTSSegmentSettings {
  ttsProvider: string;
  ttsModel: string;
  voice: string;
  nativeSpeed: number;
  ttsInstructions?: string;
}

export interface TTSSegmentLocator {
  page?: number;
  location?: string;
  readerType?: 'pdf' | 'epub' | 'html';
}

export interface TTSSegmentInput {
  segmentIndex: number;
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
  audioPresignUrl: string | null;
  audioFallbackUrl: string | null;
  durationMs: number;
  alignment: TTSSentenceAlignment | null;
  locator: TTSSegmentLocator | null;
  status: 'pending' | 'completed' | 'error';
}

export interface TTSSegmentsEnsureResponse {
  documentId: string;
  segments: TTSSegmentManifestItem[];
}
