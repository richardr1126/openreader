import { fetchOpenRouterModels } from '@openreader/tts/openrouter';
import { catalogVoiceName, providerSupportsCustomModel, resolveProviderModels } from '@openreader/tts/provider-catalog';
import { defaultModelForProviderType, resolveTtsModelForProvider } from '@openreader/tts/provider-policy';
import { resolveVoices } from '@openreader/tts/voice-resolution';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import type { ApiPrincipal } from '@/lib/server/api/principal';
import { ApiRequestError } from '@/lib/server/api/responses';
import type { SpeechProviderResource, VoiceListResource } from '@/types/voice-api';
import { db } from '@openreader/database';
import { userPreferences } from '@openreader/database/schema';
import { eq } from 'drizzle-orm';
import { listAdminProviders } from '@/lib/server/admin/providers';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { listClonedVoices } from './cloned-voices';
import { resolveSpeechPreferences } from './speech-preferences';

async function savedSpeech(principal: ApiPrincipal, runtime: Awaited<ReturnType<typeof getResolvedRuntimeConfig>>) {
  const [rows, providers] = await Promise.all([
    db.select({ dataJson: userPreferences.dataJson }).from(userPreferences).where(eq(userPreferences.userId, principal.userId)).limit(1),
    listAdminProviders(),
  ]);
  return { ...resolveSpeechPreferences(rows[0]?.dataJson, runtime, providers), providers };
}

/** Every enabled provider and the models this instance allows on it. */
export async function listSpeechProviders(principal: ApiPrincipal): Promise<SpeechProviderResource[]> {
  const runtime = await getResolvedRuntimeConfig();
  const { provider: saved, preferences, providers } = await savedSpeech(principal, runtime);
  const enabled = providers.filter(provider => provider.enabled);
  const openRouterModels = enabled.some(provider => provider.providerType === 'openrouter')
    ? await fetchOpenRouterModels().catch(() => []) : [];
  return enabled.map(provider => {
    const defaultModel = provider.defaultModel || defaultModelForProviderType(provider.providerType);
    const catalogue = resolveProviderModels(provider.providerType, { openRouterModels });
    const models = !runtime.showAllProviderModels ? catalogue.filter(({ id }) => id === defaultModel) : catalogue;
    const selected = provider.slug === saved.providerRef;
    return {
      id: provider.slug, name: provider.displayName, type: provider.providerType, defaultModel, selected,
      selectedModel: selected ? preferences.ttsModel || saved.defaultModel : null,
      models: models.some(({ id }) => id === defaultModel) ? models.map(({ id, name }) => ({ id, name })) : [{ id: defaultModel, name: defaultModel }, ...models.map(({ id, name }) => ({ id, name }))],
      acceptsCustomModel: runtime.showAllProviderModels && providerSupportsCustomModel(provider.providerType),
    };
  });
}

/** Only these providers can speak a clone. A storage failure must not hide the catalogue. */
async function ownVoices(principal: ApiPrincipal, providerType: string, provider: string, model: string) {
  if (providerType !== 'fish-audio' && providerType !== 'openrouter') return [];
  try {
    const clones = await listClonedVoices(principal.userId);
    return clones.filter(clone => clone.providerRef === provider && clone.model === model).map(({ id, name }) => ({ id, name }));
  } catch (error) {
    serverLogger.warn({ event: 'tts.voices.clones.failed', degraded: true, error: errorToLog(error) }, 'Failed to list cloned voices');
    return [];
  }
}

export async function listVoices(principal: ApiPrincipal, query: URLSearchParams): Promise<VoiceListResource> {
  let provider = query.get('provider')?.trim() || null;
  let model = query.get('model')?.trim() || null;
  if ((provider?.length ?? 0) > 200 || (model?.length ?? 0) > 512) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Provider or model is too long.');
  const runtime = await getResolvedRuntimeConfig();
  if (!provider) {
    const saved = await savedSpeech(principal, runtime);
    provider = saved.provider.providerRef;
    model ??= saved.preferences.ttsModel || saved.provider.defaultModel;
  }
  const resolved = await resolveTtsCredentials({ providerHeader: provider, fallbackProvider: runtime.defaultTtsProvider });
  if ('error' in resolved) throw new ApiRequestError(resolved.error === 'provider_unknown' ? 404 : 503,
    'PROVIDER_UNAVAILABLE', 'The selected speech provider is unavailable.');
  const providerRef = resolved.adminRecord?.slug ?? provider ?? runtime.defaultTtsProvider;
  const requestedModel = resolveTtsModelForProvider({
    providerRef, providerType: resolved.provider, model,
    sharedProviders: resolved.adminRecord ? [resolved.adminRecord] : [],
    fallbackProviderRef: runtime.defaultTtsProvider, showAllProviderModels: runtime.showAllProviderModels,
  }) || defaultModelForProviderType(resolved.provider);
  const { voices, status } = await resolveVoices({ provider: resolved.provider, model: requestedModel, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
  return { provider: providerRef, model: requestedModel, status, nextCursor: null, data: [
    ...[...new Set(voices)].map(id => ({ id, name: catalogVoiceName(id) })),
    ...await ownVoices(principal, resolved.provider, providerRef, requestedModel),
  ] };
}
