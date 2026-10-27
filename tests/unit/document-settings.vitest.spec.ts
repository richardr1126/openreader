import { describe, expect, test } from 'vitest';

import { mergeDocumentSettings, resolveBookVoice } from '../../src/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '../../src/types/document-settings';

describe('document settings language', () => {
  test('defaults to automatic language resolution', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, null).language).toBe('auto');
  });

  test('normalizes explicit BCP 47 language tags', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'zh-cn' }).language).toBe('zh-CN');
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'JA' }).language).toBe('ja');
  });

  test('preserves language when PDF settings are absent', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'fr' })).toMatchObject({
      language: 'fr',
    });
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'fr' }).pdf).toBeUndefined();
  });
});

describe('book voice override', () => {
  const defaults = { providerRef: 'kokoro', ttsModel: 'kokoro', defaultVoice: 'af_sky', defaultVoiceSpeed: 1 };

  test('keeps a trimmed override with an in-range speed', () => {
    const merged = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      voiceOverride: { providerRef: ' kokoro ', ttsModel: 'kokoro', voice: ' am_adam ', voiceSpeed: 1.4 },
    });
    expect(merged.voiceOverride).toEqual({ providerRef: 'kokoro', ttsModel: 'kokoro', voice: 'am_adam', voiceSpeed: 1.4 });
  });

  test('drops an override without a provider, model, or any picked value', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      voiceOverride: { ttsModel: 'kokoro', voice: 'am_adam' },
    }).voiceOverride).toBeUndefined();
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      voiceOverride: { providerRef: 'kokoro', ttsModel: 'kokoro', voiceSpeed: 9 },
    }).voiceOverride).toBeUndefined();
  });

  test('applies only for the provider and model it was picked for', () => {
    const override = { providerRef: 'kokoro', ttsModel: 'kokoro', voice: 'am_adam' };
    expect(resolveBookVoice({ ...defaults, override })).toEqual({
      voice: 'am_adam', voiceSpeed: 1, ownVoice: true, ownVoiceSpeed: false,
    });
    expect(resolveBookVoice({ ...defaults, ttsModel: 'other', override })).toEqual({
      voice: 'af_sky', voiceSpeed: 1, ownVoice: false, ownVoiceSpeed: false,
    });
  });

  test('a speed-only override keeps the default voice', () => {
    expect(resolveBookVoice({
      ...defaults,
      override: { providerRef: 'kokoro', ttsModel: 'kokoro', voiceSpeed: 1.5 },
    })).toEqual({ voice: 'af_sky', voiceSpeed: 1.5, ownVoice: false, ownVoiceSpeed: true });
  });
});
