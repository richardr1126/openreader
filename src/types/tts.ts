import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { TTSLocation } from '@openreader/tts/types';
export type {
  TTSLocation,
  TTSSentenceAlignment,
  TTSSentenceWord,
} from '@openreader/tts/types';

/**
 * How many segments ahead of the client's playback cursor the worker generates
 * while connected. The worker plans the whole forward extent up front but only
 * generates audio within this window just ahead of playback; it advances as the
 * client heartbeats its cursor, so generation tracks the listener instead of
 * racing to the end of the document.
 */
export const TTS_PLAYBACK_AHEAD_WINDOW = 8;

/**
 * How often the client POSTs its playback cursor while playing. Must be well
 * under the worker's cursor-stale threshold (15s) so an actively-read session is
 * never mistaken for a disconnect mid-segment.
 */
export const TTS_PLAYBACK_CURSOR_HEARTBEAT_MS = 4_000;

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
