import type { ArtifactStorage } from '../infrastructure/storage';
import type { TtsPlaybackStorage } from '../playback/storage';

export interface JobHandlerContext {
  storage: ArtifactStorage;
  playbackStorage?: TtsPlaybackStorage;
  pdfTimeoutMs: number;
  pdfHardCapMs: number;
  ttsPlaybackSegmentTimeoutMs: number;
  s3Prefix: string;
  logger?: { warn(data: unknown, message?: string): void };
  acquireProviderCapacity?: (input: {
    providerRef: string;
    characters: number;
    signal?: AbortSignal;
    /** Called if the held slot's lease is lost; the request must stop. */
    onLost?: () => void;
  }) => Promise<() => Promise<void>>;
  getProviderMaxConcurrent?: (providerRef: string) => number | null;
  coolDownProviderCapacity?: (providerRef: string, retryAfterSeconds: number) => Promise<void>;
}
