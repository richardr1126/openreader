import { describe, expect, test } from 'vitest';

import { resolveTtsSettingsViewModel } from '../../src/lib/client/settings/tts-settings';
import type { SharedProviderEntry } from '../../src/hooks/useSharedProviders';

const SHARED: SharedProviderEntry[] = [
  {
    slug: 'shared-openai',
    displayName: 'OpenAI Shared',
    providerType: 'openai',
    defaultModel: 'gpt-4o-mini-tts',
    defaultInstructions: 'Default shared instructions',
  },
  {
    slug: 'shared-replicate',
    displayName: 'Replicate Shared',
    providerType: 'replicate',
    defaultModel: 'owner/model:ver',
    defaultInstructions: null,
  },
];

describe('resolveTtsSettingsViewModel (admin/shared modes)', () => {
  test('keeps default-openai selection when that shared provider exists', () => {
    const vm = resolveTtsSettingsViewModel({
      providerRef: 'default-openai',
      providerType: 'unknown',
      modelValue: 'kokoro',
      customModelInput: '',
      showAllProviderModels: true,
      sharedProviders: [
        {
          slug: 'default-openai',
          displayName: 'Default OpenAI',
          providerType: 'openai',
          defaultModel: 'gpt-4o-mini-tts',
          defaultInstructions: null,
        },
        ...SHARED,
      ],
      allowBuiltInProviders: false,
    });

    expect(vm.selectedProviderRef).toBe('default-openai');
    expect(vm.selectedSharedProvider?.slug).toBe('default-openai');
    expect(vm.selectedModelId).toBe('gpt-4o-mini-tts');
  });

  test('restrict mode exposes only shared providers', () => {
    const vm = resolveTtsSettingsViewModel({
      providerRef: 'shared-openai',
      providerType: 'unknown',
      modelValue: 'gpt-4o-mini-tts',
      customModelInput: '',
      showAllProviderModels: true,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.providers.map((p) => p.id)).toEqual(['shared-openai', 'shared-replicate']);
    expect(vm.providers.every((p) => p.shared)).toBe(true);
  });

  test('invalid provider falls back to first available option', () => {
    const vm = resolveTtsSettingsViewModel({
      providerRef: 'missing-provider',
      providerType: 'unknown',
      modelValue: 'kokoro',
      customModelInput: '',
      showAllProviderModels: true,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.selectedSharedProvider?.slug).toBe('shared-openai');
    expect(vm.selectedModelId).toBe('gpt-4o-mini-tts');
  });

  test('custom-model capable providers use custom mode for unknown model ids', () => {
    const vm = resolveTtsSettingsViewModel({
      providerRef: 'shared-replicate',
      providerType: 'unknown',
      modelValue: 'my-custom-model',
      customModelInput: '',
      showAllProviderModels: true,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.supportsCustomModel).toBe(true);
    expect(vm.selectedModelId).toBe('custom');
    expect(vm.canSubmit).toBe(false);
  });

  test('non-custom providers fall back to preset model selection', () => {
    const vm = resolveTtsSettingsViewModel({
      providerRef: 'shared-openai',
      providerType: 'unknown',
      modelValue: 'not-in-presets',
      customModelInput: '',
      showAllProviderModels: true,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.supportsCustomModel).toBe(false);
    expect(vm.selectedModelId).not.toBe('custom');
    expect(vm.models.length).toBeGreaterThan(0);
  });

  test('legacy default-openai provider ref normalizes to first shared provider', () => {
    const vm = resolveTtsSettingsViewModel({
      providerRef: 'default-openai',
      providerType: 'unknown',
      modelValue: 'kokoro',
      customModelInput: '',
      showAllProviderModels: true,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.selectedProviderRef).toBe('shared-openai');
    expect(vm.selectedModelId).toBe('gpt-4o-mini-tts');
  });

  test('showAllProviderModels=false locks model picker to provider default', () => {
    const vm = resolveTtsSettingsViewModel({
      providerRef: 'shared-replicate',
      providerType: 'unknown',
      modelValue: 'my-custom-model',
      customModelInput: 'my-custom-model',
      showAllProviderModels: false,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.models).toEqual([{ id: 'owner/model:ver', name: 'owner/model:ver' }]);
    expect(vm.supportsCustomModel).toBe(false);
    expect(vm.selectedModelId).toBe('owner/model:ver');
    expect(vm.canSubmit).toBe(true);
  });
});
