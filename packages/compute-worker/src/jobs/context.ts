import type { ArtifactStorage } from '../infrastructure/storage';
import type { TtsPlaybackStorage } from '../playback/storage';

export interface JobHandlerContext {
  storage: ArtifactStorage;
  playbackStorage?: TtsPlaybackStorage;
  pdfTimeoutMs: number;
  pdfHardCapMs: number;
  ttsPlaybackSegmentTimeoutMs: number;
  s3Prefix: string;
}
