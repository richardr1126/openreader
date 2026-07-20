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

export interface TTSRequestError extends Error {
  status?: number;
  code?: string;
  type?: string;
  title?: string;
  detail?: string;
}

export type ClaimableCounts = {
  documents: number;
  preferences: number;
  progress: number;
  documentSettings: number;
  folders: number;
  onboarding: number;
};

export interface VoicesResponse {
  voices: string[];
}
