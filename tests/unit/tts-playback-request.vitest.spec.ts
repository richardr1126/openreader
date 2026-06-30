import { describe, expect, test } from 'vitest';
import { parseTtsPlaybackRequestBody } from '@/lib/server/tts/playback-request';

const basePayload = {
  documentId: 'abc123',
  settings: {
    providerRef: 'openai',
    providerType: 'openai',
    ttsModel: 'gpt-4o-mini-tts',
    voice: 'alloy',
    nativeSpeed: 1,
    language: 'en',
  },
  startLocation: { page: 2 },
};

describe('TTS playback request parsing', () => {
  test('accepts PDF skip block kinds in planning payload', () => {
    const parsed = parseTtsPlaybackRequestBody({
      ...basePayload,
      planning: {
        maxBlockLength: 1200,
        language: 'en',
        skipBlockKinds: ['paragraph_title', 'formula_number', 'paragraph_title'],
      },
    });

    expect(parsed?.skipBlockKinds).toEqual(['paragraph_title', 'formula_number']);
  });

  test('rejects unknown PDF skip block kinds', () => {
    expect(parseTtsPlaybackRequestBody({
      ...basePayload,
      planning: {
        skipBlockKinds: ['paragraph_title', 'not_a_real_kind'],
      },
    })).toBeNull();
  });

  test('accepts document-extent generation for worker-backed MP3 export', () => {
    const parsed = parseTtsPlaybackRequestBody({
      ...basePayload,
      startIntent: { selectedOrdinal: 0 },
      planObjectKey: 'tts_playback_plan_v1/doc/0/pdf/signature.json',
      generationExtent: 'document',
    });

    expect(parsed?.generationExtent).toBe('document');
  });

  test('rejects unknown generation extents', () => {
    expect(parseTtsPlaybackRequestBody({
      ...basePayload,
      startIntent: { selectedOrdinal: 0 },
      planObjectKey: 'tts_playback_plan_v1/doc/0/pdf/signature.json',
      generationExtent: 'chapter',
    })).toBeNull();
  });
});
