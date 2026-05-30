import { describe, expect, test } from 'vitest';
import {
  canonicalizeAudiobookSettingsForRuntime,
  coerceAudiobookGenerationSettings,
} from '../../src/lib/server/audiobooks/settings';

describe('coerceAudiobookGenerationSettings', () => {
  test('accepts current metadata shape without migration', () => {
    const result = coerceAudiobookGenerationSettings({
      providerRef: 'openai',
      providerType: 'openai',
      ttsModel: 'tts-1',
      voice: 'alloy',
      nativeSpeed: 1,
      postSpeed: 1,
      format: 'mp3',
      ttsInstructions: 'keep calm',
    });

    expect(result.migrated).toBe(false);
    expect(result.settings).toEqual({
      providerRef: 'openai',
      providerType: 'openai',
      ttsModel: 'tts-1',
      voice: 'alloy',
      nativeSpeed: 1,
      postSpeed: 1,
      format: 'mp3',
      ttsInstructions: 'keep calm',
    });
  });

  test('coerces legacy ttsProvider metadata and marks as migrated', () => {
    const result = coerceAudiobookGenerationSettings({
      ttsProvider: 'custom-openai',
      ttsModel: 'kokoro',
      voice: 'af_sarah',
      nativeSpeed: 1,
      postSpeed: 1,
      format: 'm4b',
    });

    expect(result.migrated).toBe(true);
    expect(result.settings).toEqual({
      providerRef: 'custom-openai',
      providerType: 'custom-openai',
      ttsModel: 'kokoro',
      voice: 'af_sarah',
      nativeSpeed: 1,
      postSpeed: 1,
      format: 'm4b',
    });
  });

  test('normalizes default-openai legacy ref using fallback provider', () => {
    const result = coerceAudiobookGenerationSettings({
      ttsProvider: 'default-openai',
      ttsModel: 'tts-1',
      voice: 'alloy',
      nativeSpeed: 1,
      postSpeed: 1,
      format: 'mp3',
    }, {
      fallbackProviderRef: 'openai',
    });

    expect(result.migrated).toBe(true);
    expect(result.settings?.providerRef).toBe('openai');
    expect(result.settings?.providerType).toBe('openai');
  });

  test('rejects invalid payloads', () => {
    const result = coerceAudiobookGenerationSettings({
      providerRef: 'openai',
      providerType: 'openai',
      ttsModel: 'tts-1',
      nativeSpeed: 1,
      postSpeed: 1,
      format: 'mp3',
    });

    expect(result.settings).toBeNull();
  });

  test('canonicalizes built-in provider settings to shared provider in restricted mode', () => {
    const settings = canonicalizeAudiobookSettingsForRuntime({
      settings: {
        providerRef: 'custom-openai',
        providerType: 'custom-openai',
        ttsModel: 'kokoro',
        voice: 'af_sarah',
        nativeSpeed: 1,
        postSpeed: 1,
        format: 'mp3',
        ttsInstructions: '',
      },
      restrictUserApiKeys: true,
      fallbackProviderRef: 'shared-openai',
      showAllProviderModels: false,
      sharedProviders: [
        {
          slug: 'shared-openai',
          providerType: 'openai',
          defaultModel: 'gpt-4o-mini-tts',
          defaultInstructions: 'Speak with warmth.',
        },
      ],
    });

    expect(settings.providerRef).toBe('shared-openai');
    expect(settings.providerType).toBe('openai');
    expect(settings.ttsModel).toBe('gpt-4o-mini-tts');
    expect(settings.ttsInstructions).toBe('Speak with warmth.');
  });
});
