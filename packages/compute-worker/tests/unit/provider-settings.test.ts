import { describe, expect, test } from 'vitest';
import type { TtsCredentialBrokerResponse } from '@openreader/tts/credential-broker';
import { normalizeOpenRouterOptions } from '@openreader/tts/openrouter';
import { resolveEffectiveTtsSettings } from '../../src/jobs/playback/provider-settings';

const MODEL = 'fish-audio/s2.1-pro-free:free';
const PROVIDER_OPTIONS = normalizeOpenRouterOptions('{"provider":{"options":{"fish-audio":{"temperature":0.4}}}}', MODEL);
const CREDS: TtsCredentialBrokerResponse = {
  providerRef: 'router',
  providerType: 'openrouter',
  apiKey: 'sk-never-leaks',
  baseUrl: null,
  defaultModel: MODEL,
  defaultInstructions: null,
  defaultModelOptions: PROVIDER_OPTIONS,
};
const SETTINGS = { providerRef: 'router', providerType: 'openrouter' as const, ttsModel: MODEL, voice: 'default', nativeSpeed: 1 };

describe('resolveEffectiveTtsSettings model options', () => {
  test('uses the provider default when the request has none', () => {
    expect(resolveEffectiveTtsSettings(SETTINGS, CREDS).ttsModelOptions).toBe(PROVIDER_OPTIONS);
  });

  test('lets the request options replace the provider default', () => {
    const own = normalizeOpenRouterOptions('{"provider":{"options":{"fish-audio":{"temperature":0.9}}}}', MODEL);
    expect(resolveEffectiveTtsSettings({ ...SETTINGS, ttsModelOptions: own }, CREDS).ttsModelOptions).toBe(own);
  });

  test('never applies the provider default to a different model', () => {
    expect(resolveEffectiveTtsSettings({ ...SETTINGS, ttsModel: 'openai/gpt-4o-mini-tts' }, CREDS).ttsModelOptions).toBe('');
  });
});
