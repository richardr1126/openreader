import { describe, expect, test } from 'vitest';

import {
  sanitizePreferencesPatch,
  sanitizeSavedVoices,
  type PreferenceNormalizationContext,
} from '../../src/lib/server/user/preferences-normalize';

function makeContext(overrides: Partial<PreferenceNormalizationContext> = {}): PreferenceNormalizationContext {
  return {
    showAllProviderModels: true,
    restrictUserApiKeys: true,
    sharedProviders: [
      { slug: 'shared-a', providerType: 'openai', defaultModel: 'gpt-4o-mini-tts', defaultInstructions: 'hi' },
      { slug: 'shared-b', providerType: 'custom-openai', defaultModel: 'kokoro', defaultInstructions: null },
    ],
    ...overrides,
  };
}

describe('sanitizePreferencesPatch — inherit-by-default provider model', () => {
  test('preserves an empty providerRef as "inherit" rather than collapsing to a concrete provider', () => {
    const { patch, migrated } = sanitizePreferencesPatch(
      { providerRef: '', voiceSpeed: 1.5 },
      makeContext(),
      { fillMissingProvider: true },
    );
    expect(patch.providerRef).toBe('');
    expect(patch.providerType).toBe('unknown');
    expect(patch.ttsModel).toBe('');
    expect(patch.voiceSpeed).toBe(1.5);
    expect(migrated).toBe(false);
  });

  test('migrates a stale built-in (custom-openai) selection to inherit under restricted mode', () => {
    const { patch, migrated } = sanitizePreferencesPatch(
      { providerRef: 'custom-openai', providerType: 'custom-openai', ttsModel: 'kokoro' },
      makeContext({ restrictUserApiKeys: true }),
      { fillMissingProvider: true },
    );
    expect(patch.providerRef).toBe('');
    expect(patch.providerType).toBe('unknown');
    expect(patch.ttsModel).toBe('');
    expect(migrated).toBe(true);
  });

  test('keeps an explicit built-in selection when API keys are NOT restricted', () => {
    const { patch } = sanitizePreferencesPatch(
      { providerRef: 'openai', providerType: 'openai', ttsModel: 'tts-1' },
      makeContext({ restrictUserApiKeys: false }),
      { fillMissingProvider: false },
    );
    expect(patch.providerRef).toBe('openai');
    expect(patch.providerType).toBe('openai');
    expect(patch.ttsModel).toBe('tts-1');
  });

  test('preserves an explicit shared-provider selection and resolves its type', () => {
    const { patch } = sanitizePreferencesPatch(
      { providerRef: 'shared-b', ttsModel: 'my-model' },
      makeContext(),
      { fillMissingProvider: false },
    );
    expect(patch.providerRef).toBe('shared-b');
    expect(patch.providerType).toBe('custom-openai');
    expect(patch.ttsModel).toBe('my-model');
  });

  test('locks the model to the shared provider default when showAllProviderModels is false', () => {
    const { patch } = sanitizePreferencesPatch(
      { providerRef: 'shared-a', ttsModel: 'something-else' },
      makeContext({ showAllProviderModels: false }),
      { fillMissingProvider: false },
    );
    expect(patch.providerRef).toBe('shared-a');
    expect(patch.ttsModel).toBe('gpt-4o-mini-tts');
  });

  test('treats the legacy "default-openai" sentinel as inherit when it is not a real shared provider', () => {
    const { patch, migrated } = sanitizePreferencesPatch(
      { providerRef: 'default-openai' },
      makeContext(),
      { fillMissingProvider: true },
    );
    expect(patch.providerRef).toBe('');
    expect(migrated).toBe(true);
  });

  test('does not force provider fields on a partial PUT patch that omits them', () => {
    const { patch } = sanitizePreferencesPatch(
      { voice: 'af_sarah' },
      makeContext(),
      { fillMissingProvider: false },
    );
    expect(patch.voice).toBe('af_sarah');
    expect('providerRef' in patch).toBe(false);
    expect('providerType' in patch).toBe(false);
    expect('ttsModel' in patch).toBe(false);
  });

  test('rejects arrays where preference records are expected', () => {
    expect(sanitizePreferencesPatch(['voice'], makeContext(), { fillMissingProvider: false })).toEqual({
      patch: {},
      migrated: false,
    });
    expect(sanitizeSavedVoices(['af_sarah'])).toEqual({});
  });
});
