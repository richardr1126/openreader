import { presignTtsSegmentAudioGet } from '@/lib/server/tts/segments-blobstore';
import { isLoopbackS3Endpoint } from '@/lib/server/storage/s3';

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

  // A loopback S3 endpoint (the embedded-SeaweedFS-behind-a-reverse-proxy default,
  // S3_ENDPOINT=http://127.0.0.1:8333) produces presigned URLs that a remote
  // browser cannot reach. Serve audio through the same-origin fallback proxy in
  // that case instead of handing out an unreachable direct URL.
  const presignResolver = options.presignResolver ?? presignTtsSegmentAudioGet;
  const directUrl = isLoopbackS3Endpoint()
    ? null
    : await presignResolver(options.audioKey, {
        expiresInSeconds: options.expiresInSeconds,
      }).catch(() => null);

  return {
    audioPresignUrl: directUrl ?? fallbackUrl,
    audioFallbackUrl: fallbackUrl,
  };
}
