import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { getDefaultVoices } from '@/lib/shared/tts-provider-catalog';
import { resolveVoices } from '@/lib/server/tts/voice-resolution';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';

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

    const requestedModel = req.headers.get('x-tts-model')
      || resolved.adminRecord?.defaultModel
      || 'tts-1';
    const voices = await resolveVoices({
      provider: resolved.provider,
      model: requestedModel,
      apiKey: resolved.apiKey || 'none',
      baseUrl: resolved.baseUrl,
    });
    return NextResponse.json({ voices });
  } catch (error) {
    console.error('Error in voices endpoint:', error);
    const provider = req.headers.get('x-tts-provider') || 'openai';
    const model = req.headers.get('x-tts-model') || 'tts-1';
    return NextResponse.json(
      { error: 'Failed to resolve voices', fallbackVoices: getDefaultVoices(provider, model) },
      { status: 500 },
    );
  }
}
