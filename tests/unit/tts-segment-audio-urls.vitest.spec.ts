import { describe, expect, test } from 'vitest';
import {
  buildSegmentAudioFallbackUrl,
  resolveSegmentAudioUrls,
} from '../../src/lib/server/tts/segment-audio-urls';

describe('tts segment audio url resolution', () => {
  test('builds fallback URL with encoded params', () => {
    const url = buildSegmentAudioFallbackUrl('doc 1', 'segment/2');
    expect(url).toBe('/api/tts/segments/audio/fallback?documentId=doc%201&segmentId=segment%2F2');
  });

  test('returns null urls when no audio key is present', async () => {
    const urls = await resolveSegmentAudioUrls({
      documentId: 'doc-1',
      segmentId: 'seg-1',
      audioKey: null,
    });
    expect(urls).toEqual({
      audioPresignUrl: null,
      audioFallbackUrl: null,
    });
  });

  test('returns direct signed URL when presign succeeds', async () => {
    let receivedKey = '';
    let receivedExpiresIn: number | undefined;
    const urls = await resolveSegmentAudioUrls({
      documentId: 'doc-1',
      segmentId: 'seg-1',
      audioKey: 'audio-key-1',
      expiresInSeconds: 1200,
      presignResolver: async (audioKey, options) => {
        receivedKey = audioKey;
        receivedExpiresIn = options?.expiresInSeconds;
        return 'https://signed.example/audio.mp3';
      },
    });
    expect(receivedKey).toBe('audio-key-1');
    expect(receivedExpiresIn).toBe(1200);
    expect(urls).toEqual({
      audioPresignUrl: 'https://signed.example/audio.mp3',
      audioFallbackUrl: '/api/tts/segments/audio/fallback?documentId=doc-1&segmentId=seg-1',
    });
  });

  test('falls back to proxy URL when presign fails', async () => {
    const urls = await resolveSegmentAudioUrls({
      documentId: 'doc-1',
      segmentId: 'seg-1',
      audioKey: 'audio-key-1',
      presignResolver: async () => {
        throw new Error('presign failed');
      },
    });
    expect(urls).toEqual({
      audioPresignUrl: '/api/tts/segments/audio/fallback?documentId=doc-1&segmentId=seg-1',
      audioFallbackUrl: '/api/tts/segments/audio/fallback?documentId=doc-1&segmentId=seg-1',
    });
  });
});
