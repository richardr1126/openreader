import { presignTtsSegmentAudioGet } from '@/lib/server/tts/segments-blobstore';

export type TTSSegmentAudioUrls = {
  audioPresignUrl: string | null;
  audioFallbackUrl: string | null;
};

export function buildSegmentAudioFallbackUrl(documentId: string, segmentId: string): string {
  const encodedDocumentId = encodeURIComponent(documentId);
  const encodedSegmentId = encodeURIComponent(segmentId);
  return `/api/tts/segments/audio/fallback?documentId=${encodedDocumentId}&segmentId=${encodedSegmentId}`;
}

type ResolveSegmentAudioUrlOptions = {
  documentId: string;
  segmentId: string;
  audioKey: string | null;
  expiresInSeconds?: number;
  presignResolver?: (audioKey: string, options?: { expiresInSeconds?: number }) => Promise<string>;
};

export async function resolveSegmentAudioUrls(
  options: ResolveSegmentAudioUrlOptions,
): Promise<TTSSegmentAudioUrls> {
  const fallbackUrl = buildSegmentAudioFallbackUrl(options.documentId, options.segmentId);
  if (!options.audioKey) {
    return {
      audioPresignUrl: null,
      audioFallbackUrl: null,
    };
  }

  const presignResolver = options.presignResolver ?? presignTtsSegmentAudioGet;
  const directUrl = await presignResolver(options.audioKey, {
    expiresInSeconds: options.expiresInSeconds,
  }).catch(() => null);

  return {
    audioPresignUrl: directUrl ?? fallbackUrl,
    audioFallbackUrl: fallbackUrl,
  };
}
