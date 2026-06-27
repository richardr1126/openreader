import type {
  TTSAudiobookChapter,
  TTSAudiobookFormat,
} from '@/types/tts';
import type { TtsProviderType } from '@openreader/tts/provider-catalog';
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
