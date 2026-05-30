import { describe, expect, test } from 'vitest';

import {
  REPLICATE_KOKORO_82M_VERSIONED_MODEL,
  getDefaultVoices,
  providerSupportsCustomModel,
  resolveProviderModels,
  supportsNativeModelSpeed,
  supportsTtsInstructions,
} from '../../src/lib/shared/tts-provider-catalog';
import { normalizeLegacyProviderRef, resolveProviderDefaults, resolveTtsModelForProvider } from '../../src/lib/shared/tts-provider-policy';
import { resolveReplicateVoiceInputKey, resolveVoices } from '../../src/lib/server/tts/voice-resolution';
import { applyConfigUpdate, getVoicePreferenceKey } from '../../src/lib/client/config/updates';
import { buildSyncedPreferencePatch } from '../../src/lib/client/config/preferences';

describe('tts provider catalog', () => {
  test('resolves provider models with fixed Deepinfra catalog', () => {
    expect(resolveProviderModels('openai').map((model) => model.id)).toEqual([
      'tts-1',
      'tts-1-hd',
      'gpt-4o-mini-tts',
    ]);

    expect(resolveProviderModels('deepinfra', {
      apiKey: '',
    }).map((model) => model.id)).toEqual([
      'hexgrad/Kokoro-82M',
      'canopylabs/orpheus-3b-0.1-ft',
      'sesame/csm-1b',
      'ResembleAI/chatterbox',
      'Zyphra/Zonos-v0.1-hybrid',
      'Zyphra/Zonos-v0.1-transformer',
      'custom',
    ]);
  });

  test('resolves default voices and instruction support unchanged', () => {
    expect(getDefaultVoices('openai', 'gpt-4o-mini-tts')).toContain('sage');
    expect(getDefaultVoices('custom-openai', 'kokoro')).toContain('af_sarah');
    expect(getDefaultVoices('deepinfra', 'ResembleAI/chatterbox')).toEqual(['None']);
    expect(getDefaultVoices('deepinfra', 'Zyphra/Zonos-v0.1-transformer')).toEqual(['random']);
    expect(supportsTtsInstructions('gpt-4o-mini-tts')).toBe(true);
    expect(supportsTtsInstructions('tts-1')).toBe(false);
    expect(providerSupportsCustomModel('openai')).toBe(false);
    expect(providerSupportsCustomModel('deepinfra')).toBe(true);
  });

  test('uses blocklist semantics for Replicate native speed support', () => {
    expect(supportsNativeModelSpeed('replicate', REPLICATE_KOKORO_82M_VERSIONED_MODEL)).toBe(true);
    expect(supportsNativeModelSpeed('replicate', 'acme/runtime-speed-model')).toBe(true);
    expect(supportsNativeModelSpeed('replicate', 'google/gemini-3.1-flash-tts')).toBe(false);
    expect(supportsNativeModelSpeed('replicate', 'qwen/qwen3-tts')).toBe(false);
  });

  test('preserves default-openai unless explicit non-default fallback is provided', () => {
    expect(normalizeLegacyProviderRef('default-openai', 'shared-replicate')).toBe('shared-replicate');
    expect(normalizeLegacyProviderRef('default-openai', '')).toBe('default-openai');
    expect(normalizeLegacyProviderRef('default-openai', 'default-openai')).toBe('default-openai');
    expect(normalizeLegacyProviderRef('default-openai')).toBe('default-openai');
  });

  test('resolveProviderDefaults keeps runtime/admin default provider ref when valid', () => {
    const defaults = resolveProviderDefaults({
      providerRef: 'default-openai',
      providerType: 'unknown',
    });
    expect(defaults.providerRef).toBe('default-openai');
    expect(defaults.providerType).toBe('unknown');
  });

  test('resolves shared-provider default model as authoritative', () => {
    const defaults = resolveProviderDefaults({
      providerRef: 'shared-replicate',
      providerType: 'unknown',
      fallbackProviderRef: 'shared-replicate',
      sharedProviders: [
        {
          slug: 'shared-replicate',
          providerType: 'replicate',
          defaultModel: REPLICATE_KOKORO_82M_VERSIONED_MODEL,
          defaultInstructions: 'Narrate warmly',
        },
      ],
    });
    expect(defaults.providerRef).toBe('shared-replicate');
    expect(defaults.providerType).toBe('replicate');
    expect(defaults.defaultModel).toBe(REPLICATE_KOKORO_82M_VERSIONED_MODEL);
    expect(defaults.defaultInstructions).toBe('Narrate warmly');
  });

  test('resolveTtsModelForProvider enforces shared default model when showAllProviderModels is false', () => {
    const resolved = resolveTtsModelForProvider({
      providerRef: 'shared-replicate',
      providerType: 'unknown',
      model: 'acme/custom-model',
      showAllProviderModels: false,
      sharedProviders: [
        {
          slug: 'shared-replicate',
          providerType: 'replicate',
          defaultModel: REPLICATE_KOKORO_82M_VERSIONED_MODEL,
          defaultInstructions: null,
        },
      ],
    });
    expect(resolved).toBe(REPLICATE_KOKORO_82M_VERSIONED_MODEL);
  });

  test('resolveTtsModelForProvider keeps requested model when showAllProviderModels is true', () => {
    const resolved = resolveTtsModelForProvider({
      providerRef: 'shared-replicate',
      providerType: 'unknown',
      model: 'acme/custom-model',
      showAllProviderModels: true,
      sharedProviders: [
        {
          slug: 'shared-replicate',
          providerType: 'replicate',
          defaultModel: REPLICATE_KOKORO_82M_VERSIONED_MODEL,
          defaultInstructions: null,
        },
      ],
    });
    expect(resolved).toBe('acme/custom-model');
  });

  test('resolveTtsModelForProvider falls back to built-in provider default model when locked', () => {
    const resolved = resolveTtsModelForProvider({
      providerRef: 'openai',
      providerType: 'openai',
      model: 'gpt-4o-mini-tts',
      showAllProviderModels: false,
    });
    expect(resolved).toBe('tts-1');
  });

  test('keeps explicit empty custom-openai voices response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ voices: [] }),
    }) as Response;

    try {
      await expect(resolveVoices({
        provider: 'custom-openai',
        model: 'kokoro',
        apiKey: 'token',
        baseUrl: 'https://example.com',
      })).resolves.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetches custom Replicate model voices from model schema', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let url = '';
    globalThis.fetch = async (input) => {
      calls += 1;
      url = String(input);
      return {
        ok: true,
        json: async () => ({
          latest_version: {
            openapi_schema: {
              components: {
                schemas: {
                  Input: {
                    type: 'object',
                    properties: {
                      voice: {
                        type: 'string',
                        enum: ['Narrator A', 'Narrator B'],
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      } as Response;
    };

    try {
      await expect(resolveVoices({
        provider: 'replicate',
        model: 'acme/my-tts-model-voices',
        apiKey: 'r8_token',
      })).resolves.toEqual(['Narrator A', 'Narrator B']);
      expect(calls).toBe(1);
      expect(url).toContain('/v1/models/acme/my-tts-model-voices');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('falls back to default voice for custom Replicate models when schema lookup fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as Response;

    try {
      await expect(resolveVoices({
        provider: 'replicate',
        model: 'acme/my-tts-model-fallback',
        apiKey: 'r8_token',
      })).resolves.toEqual(['default']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses schema voices first for built-in Replicate models', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          latest_version: {
            openapi_schema: {
              components: {
                schemas: {
                  Input: {
                    type: 'object',
                    properties: {
                      speaker: {
                        type: 'string',
                        enum: ['Schema Aiden', 'Schema Dylan'],
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      } as Response;
    };

    try {
      await expect(resolveVoices({
        provider: 'replicate',
        model: 'qwen/qwen3-tts',
        apiKey: 'r8_token',
      })).resolves.toEqual(['Schema Aiden', 'Schema Dylan']);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('falls back to built-in Replicate static voices when schema has no voice enum', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          latest_version: {
            openapi_schema: {
              components: {
                schemas: {
                  Input: {
                    type: 'object',
                    properties: {
                      speaker: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        }),
      } as Response;
    };

    try {
      await expect(resolveVoices({
        provider: 'replicate',
        model: 'inworld/tts-1.5-mini',
        apiKey: 'r8_token',
      })).resolves.toEqual(['Ashley', 'Dennis', 'Alex', 'Darlene']);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('resolves Replicate custom-model voice input key and caches it', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          latest_version: {
            openapi_schema: {
              components: {
                schemas: {
                  Input: {
                    type: 'object',
                    properties: {
                      voice_id: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        }),
      } as Response;
    };

    try {
      await expect(resolveReplicateVoiceInputKey({
        provider: 'replicate',
        model: 'acme/custom-voice-model',
        apiKey: 'r8_token',
      })).resolves.toBe('voice_id');

      await expect(resolveReplicateVoiceInputKey({
        provider: 'replicate',
        model: 'acme/custom-voice-model',
        apiKey: 'r8_token',
      })).resolves.toBe('voice_id');

      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('shares Replicate schema fetch between voices and voice-key resolution', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          latest_version: {
            openapi_schema: {
              components: {
                schemas: {
                  Input: {
                    type: 'object',
                    properties: {
                      voice: {
                        type: 'string',
                        enum: ['V1', 'V2'],
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      } as Response;
    };

    try {
      await expect(resolveVoices({
        provider: 'replicate',
        model: 'acme/shared-schema-model',
        apiKey: 'r8_token',
      })).resolves.toEqual(['V1', 'V2']);

      await expect(resolveReplicateVoiceInputKey({
        provider: 'replicate',
        model: 'acme/shared-schema-model',
        apiKey: 'r8_token',
      })).resolves.toBe('voice');

      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('config helpers', () => {
  test('persists voice preferences by provider/model pair', () => {
    expect(getVoicePreferenceKey('openai', 'tts-1')).toBe('openai:tts-1');

    const voiceUpdate = applyConfigUpdate({
      providerRef: 'openai',
      providerType: 'openai',
      ttsModel: 'tts-1',
      savedVoices: {},
    }, 'voice', 'alloy');
    expect(voiceUpdate.storagePatch).toEqual({
      savedVoices: { 'openai:tts-1': 'alloy' },
      voice: 'alloy',
    });

    const providerUpdate = applyConfigUpdate({
      providerRef: 'openai',
      providerType: 'openai',
      ttsModel: 'tts-1',
      savedVoices: {
        'deepinfra:hexgrad/Kokoro-82M': 'af_sarah',
      },
    }, 'providerRef', 'deepinfra');
    expect(providerUpdate.storagePatch).toEqual({
      providerRef: 'deepinfra',
      voice: '',
    });
  });

  test('builds synced preference patches and honors non-default filtering', () => {
    expect(buildSyncedPreferencePatch({
      voiceSpeed: 1.2,
      baseUrl: 'http://localhost',
      ttsModel: 'kokoro',
    })).toEqual({
      voiceSpeed: 1.2,
      ttsModel: 'kokoro',
    });

    expect(buildSyncedPreferencePatch({
      voiceSpeed: 1,
      ttsModel: 'kokoro',
    }, { nonDefaultOnly: true })).toEqual({});
  });
});
