import type { TtsCredentialBrokerResponse } from '@openreader/tts/credential-broker';
import { resolveEffectiveTtsInstructions } from '@openreader/tts/instructions';
import { resolveTtsModelForProvider } from '@openreader/tts/provider-policy';
import type { TTSSegmentSettings } from '@openreader/tts/types';

/**
 * Settings a synthesis request actually runs with once the credential broker
 * has resolved the provider: the broker's provider identity, the model the
 * provider accepts, and the provider's default instructions when the request
 * has none. Shared by playback segments and voice previews so both speak with
 * the same resolved voice.
 */
export function resolveEffectiveTtsSettings(
  settings: TTSSegmentSettings,
  creds: TtsCredentialBrokerResponse,
): TTSSegmentSettings {
  const effectiveModel = resolveTtsModelForProvider({
    providerRef: creds.providerRef,
    providerType: creds.providerType,
    model: settings.ttsModel,
    sharedProviders: [{
      slug: creds.providerRef,
      providerType: creds.providerType,
      defaultModel: creds.defaultModel,
      defaultInstructions: creds.defaultInstructions,
    }],
    fallbackProviderRef: '',
    showAllProviderModels: true,
  });
  return {
    ...settings,
    providerRef: creds.providerRef,
    providerType: creds.providerType,
    ttsModel: effectiveModel,
    ttsInstructions: resolveEffectiveTtsInstructions({
      model: effectiveModel,
      requestInstructions: settings.ttsInstructions,
      sharedDefaultInstructions: creds.defaultInstructions,
    }) ?? '',
  };
}
