import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { isBuiltInTtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { defaultModelForProviderType, resolveTtsModelForProvider, resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { resolveVoices } from '@/lib/server/tts/voice-resolution';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { normalizeServerError, toApiErrorBody, toHttpStatus } from '@/lib/server/errors/contract';

export async function GET(req: NextRequest) {
  try {
    // Auth check - require session
    const session = await auth?.api.getSession({ headers: req.headers });
    if (auth && !session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const runtimeConfig = await getResolvedRuntimeConfig();
    const resolved = await resolveTtsCredentials({
      providerHeader: req.headers.get('x-tts-provider'),
      apiKeyHeader: req.headers.get('x-openai-key'),
      baseUrlHeader: req.headers.get('x-openai-base-url'),
      fallbackProvider: runtimeConfig.defaultTtsProvider,
      restrictUserApiKeys: runtimeConfig.restrictUserApiKeys,
    });

    if ('error' in resolved) {
      const status = resolved.error === 'no_shared_provider_configured'
        ? 503
        : resolved.error === 'provider_disabled'
          ? 503
          : 404;
      return NextResponse.json(
        {
          error: resolved.error === 'no_shared_provider_configured'
            ? 'User API keys are restricted and no shared provider is configured.'
            : `Unknown or disabled TTS provider: ${resolved.slug}`,
        },
        { status },
      );
    }

    if (!isBuiltInTtsProviderId(resolved.provider)) {
      return errorResponse(new Error(`Unsupported provider type: ${resolved.provider}`), {
        apiErrorMessage: `Unsupported provider type: ${resolved.provider}`,
        normalize: { code: 'TTS_VOICES_UNSUPPORTED_PROVIDER', errorClass: 'validation', httpStatus: 500 },
      });
    }
    const effectiveProviderRef = resolved.adminRecord?.slug
      ?? req.headers.get('x-tts-provider')
      ?? runtimeConfig.defaultTtsProvider;
    const requestedModel = resolveTtsModelForProvider({
      providerRef: effectiveProviderRef,
      providerType: resolved.provider,
      model: req.headers.get('x-tts-model'),
      sharedProviders: resolved.adminRecord ? [resolved.adminRecord] : [],
      fallbackProviderRef: runtimeConfig.defaultTtsProvider,
      showAllProviderModels: runtimeConfig.showAllProviderModels,
    }) || defaultModelForProviderType(resolved.provider);
    const voices = await resolveVoices({
      provider: resolved.provider,
      model: requestedModel,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
    });
    return NextResponse.json({ voices });
  } catch (error) {
    serverLogger.error({
      event: 'tts.voices.resolve.failed',
      error: errorToLog(error),
    }, 'Failed to resolve voices');
    const providerRef = req.headers.get('x-tts-provider') || 'openai';
    const model = req.headers.get('x-tts-model') || 'tts-1';
    const provider = isBuiltInTtsProviderId(providerRef) ? providerRef : 'openai';
    const normalized = normalizeServerError(error, {
      code: 'TTS_VOICES_RESOLVE_FAILED',
      errorClass: 'upstream',
    });
    const fallbackVoices = resolveTtsProviderModelPolicy({
      providerRef,
      providerType: provider,
      model,
    }).defaultVoices;
    return NextResponse.json(
      {
        ...toApiErrorBody(
          { ...normalized, message: 'Failed to resolve voices' },
          { includeDetails: false, includeRetryable: false },
        ),
        fallbackVoices,
      },
      { status: toHttpStatus(normalized) },
    );
  }
}
