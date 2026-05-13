import { expect, test } from '@playwright/test';

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

test.describe('resolveTtsSettingsViewModel (admin/shared modes)', () => {
  test('restrict mode exposes only shared providers', () => {
    const vm = resolveTtsSettingsViewModel({
      provider: 'shared-openai',
      modelValue: 'gpt-4o-mini-tts',
      customModelInput: '',
      showAllDeepInfra: false,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.providers.map((p) => p.id)).toEqual(['shared-openai', 'shared-replicate']);
    expect(vm.providers.every((p) => p.shared)).toBe(true);
  });

  test('invalid provider falls back to first available option', () => {
    const vm = resolveTtsSettingsViewModel({
      provider: 'missing-provider',
      modelValue: 'gpt-4o-mini-tts',
      customModelInput: '',
      showAllDeepInfra: false,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.selectedSharedProvider?.slug).toBe('shared-openai');
  });

  test('custom-model capable providers use custom mode for unknown model ids', () => {
    const vm = resolveTtsSettingsViewModel({
      provider: 'shared-replicate',
      modelValue: 'my-custom-model',
      customModelInput: '',
      showAllDeepInfra: false,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.supportsCustomModel).toBe(true);
    expect(vm.selectedModelId).toBe('custom');
    expect(vm.canSubmit).toBe(false);
  });

  test('non-custom providers fall back to preset model selection', () => {
    const vm = resolveTtsSettingsViewModel({
      provider: 'shared-openai',
      modelValue: 'not-in-presets',
      customModelInput: '',
      showAllDeepInfra: false,
      sharedProviders: SHARED,
      allowBuiltInProviders: false,
    });

    expect(vm.supportsCustomModel).toBe(false);
    expect(vm.selectedModelId).not.toBe('custom');
    expect(vm.models.length).toBeGreaterThan(0);
  });
});
