import { defaultModelForProviderType, resolveTtsModelForProvider } from '@openreader/tts/provider-policy';
import { resolveVoices } from '@openreader/tts/voice-resolution';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import type { ApiPrincipal } from '@/lib/server/api/principal';
import { ApiRequestError } from '@/lib/server/api/responses';
import type { VoiceListResource } from '@/types/voice-api';
import { db } from '@openreader/database';
import { userPreferences } from '@openreader/database/schema';
import { eq } from 'drizzle-orm';
import { listAdminProviders } from '@/lib/server/admin/providers';
import { resolveSpeechPreferences } from './speech-preferences';

export async function listVoices(principal: ApiPrincipal, query: URLSearchParams): Promise<VoiceListResource> {
  let provider = query.get('provider')?.trim() || null;
  let model = query.get('model')?.trim() || null;
  if ((provider?.length ?? 0) > 200 || (model?.length ?? 0) > 512) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Provider or model is too long.');
  const runtime = await getResolvedRuntimeConfig();
  if (!provider) {
    const [rows, providers] = await Promise.all([
      db.select({ dataJson: userPreferences.dataJson }).from(userPreferences).where(eq(userPreferences.userId, principal.userId)).limit(1),
      listAdminProviders(),
    ]);
    const saved = resolveSpeechPreferences(rows[0]?.dataJson, runtime, providers);
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
  const voices = await resolveVoices({ provider: resolved.provider, model: requestedModel, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
  return { provider: providerRef, model: requestedModel, nextCursor: null,
    data: [...new Set(voices)].map(id => ({ id, name: id })) };
}
