import type { NextRequest } from 'next/server';
import { resolveTtsLanguage } from '@openreader/tts/language';
import { resolveVoices } from '@openreader/tts/voice-resolution';
import { resolveProviderDefaults, resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { APP_CONFIG_DEFAULTS, type AppConfigValues } from '@/types/config';
import type { ReaderPayload, ReaderPlaybackPreparation } from '@/types/reader-bootstrap';
import { mergeDocumentSettings, resolveBookVoice } from '@/lib/shared/document-settings';
import { assertAuthoritativePlaybackPlan, normalizePlaybackPlan } from '@/lib/shared/playback-plan';
import { listAdminProviders } from '@/lib/server/admin/providers';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { ComputeWorkerClient, getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type { TtsPlaybackPlanResult } from '@/lib/server/compute-worker/protocol';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { ComputeAdmissionLimitedError, createAdmittedComputeOperation } from '@/lib/server/compute-limits/run-admitted';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { buildTtsPlaybackPlanningInput, toTtsPlaybackPlanRequest, type ParsedTtsPlaybackRequestBody } from '@/lib/server/tts/playback-request';
import { buildPlaybackGrid, readTtsPlaybackPlanArtifact } from '@/lib/server/tts/playback-plans';
import type { ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { sanitizePreferencesPatch, type PreferenceNormalizationContext } from '@/lib/server/user/preferences-normalize';
import type { ReaderBootstrapResolution } from './bootstrap';

function preferenceContext(
  runtimeConfig: Awaited<ReturnType<typeof getResolvedRuntimeConfig>>,
  providers: Awaited<ReturnType<typeof listAdminProviders>>,
): PreferenceNormalizationContext {
  return {
    showAllProviderModels: runtimeConfig.showAllProviderModels,
    sharedProviders: providers.filter((provider) => provider.enabled).map((provider) => ({
      slug: provider.slug,
      providerType: provider.providerType,
      defaultModel: provider.defaultModel,
      defaultInstructions: provider.defaultInstructions,
    })),
  };
}

export async function resolveReaderPlayback(
  request: NextRequest,
  documentId: string,
  scope: ResolvedSegmentDocumentScope,
  settings: ReturnType<typeof mergeDocumentSettings>,
  storedPreferences: Record<string, unknown>,
): Promise<ReaderBootstrapResolution | { plan: ReaderPayload['plan']; playback: ReaderPlaybackPreparation }> {
  if (!isComputeWorkerAvailable()) {
    return {
      result: {
        status: 'error',
        message: 'The compute worker required for reader playback is unavailable.',
        retryable: true,
      },
    };
  }
  const [runtimeConfig, providers] = await Promise.all([
    getResolvedRuntimeConfig(),
    listAdminProviders(),
  ]);
  const normalization = preferenceContext(runtimeConfig, providers);
  const patch = sanitizePreferencesPatch(
    storedPreferences,
    normalization,
    { fillMissingProvider: true },
  ).patch;
  const preferences: AppConfigValues = { ...APP_CONFIG_DEFAULTS, ...patch };
  const provider = resolveProviderDefaults({
    providerRef: preferences.providerRef,
    providerType: preferences.providerType,
    sharedProviders: normalization.sharedProviders,
    fallbackProviderRef: runtimeConfig.defaultTtsProvider,
  });
  const model = preferences.ttsModel || provider.defaultModel;
  const policy = resolveTtsProviderModelPolicy({
    providerRef: provider.providerRef,
    providerType: provider.providerType,
    model,
  });
  const bookVoice = resolveBookVoice({
    override: settings.voiceOverride,
    providerRef: provider.providerRef,
    ttsModel: model,
    defaultVoice: preferences.voice,
    defaultVoiceSpeed: preferences.voiceSpeed,
  });
  // Resolve the same unsaved default as the voice picker before naming the
  // audio cache. Plans may be shared by different voices; the plan's settings
  // hash therefore cannot identify the initial cached-audio view.
  let voice = bookVoice.voice;
  if (!voice) {
    const credentials = await resolveTtsCredentials({
      providerHeader: provider.providerRef,
      fallbackProvider: runtimeConfig.defaultTtsProvider,
    });
    if ('error' in credentials) {
      return { result: { status: 'error', message: 'The playback provider is unavailable.', retryable: true } };
    }
    const voices = await resolveVoices({
      provider: credentials.provider,
      model,
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
    });
    voice = voices[0] ?? policy.defaultVoices[0] ?? '';
  }
  const language = resolveTtsLanguage({
    configuredLanguage: settings.language || 'auto',
    voice,
  });
  const parsed: ParsedTtsPlaybackRequestBody = {
    documentId,
    settings: {
      providerRef: provider.providerRef,
      providerType: provider.providerType,
      ttsModel: model,
      voice,
      nativeSpeed: policy.supportsNativeModelSpeed ? bookVoice.voiceSpeed : 1,
      ...(policy.supportsInstructions && (preferences.ttsInstructions || provider.defaultInstructions)
        ? { ttsInstructions: preferences.ttsInstructions || provider.defaultInstructions }
        : {}),
      language,
    },
    startLocation: {},
    maxBlockLength: preferences.ttsSegmentMaxBlockLength,
    language,
    ...(scope.readerType === 'pdf'
      ? { skipBlockKinds: settings.pdf?.skipBlockKinds ?? [] }
      : {}),
  };
  const planningInput = await buildTtsPlaybackPlanningInput(parsed, scope);
  let operation;
  try {
    operation = await createAdmittedComputeOperation({
      policy: runtimeConfig.computeLimitPolicies,
      action: 'tts_playback_plan',
      requestKey: `${documentId}:${scope.documentVersion}:${planningInput.settingsHash}`,
      subject: {
        userId: scope.userId,
        isAnonymous: scope.isAnonymousUser,
        ip: getClientIp(request),
      },
      create: () => new ComputeWorkerClient().createTtsPlaybackPlanOperation(
        toTtsPlaybackPlanRequest({
          parsed,
          scope,
          ...planningInput,
          planning: planningInput.planning,
        }),
      ),
    });
  } catch (error) {
    if (!(error instanceof ComputeAdmissionLimitedError)) throw error;
    return {
      result: {
        status: 'error',
        message: error.message,
        retryable: true,
      },
    };
  }
  if (operation.status === 'queued' || operation.status === 'running') {
    return { result: { status: 'pending' }, operationId: operation.opId };
  }
  if (operation.status === 'failed') {
    return {
      result: {
        status: 'error',
        message: operation.error?.message || 'The reading plan could not be prepared.',
        retryable: true,
      },
    };
  }
  const result = operation.result as TtsPlaybackPlanResult | undefined;
  if (!result?.planObjectKey) {
    return {
      result: {
        status: 'error',
        message: 'The reading plan completed without an artifact.',
        retryable: true,
      },
    };
  }
  const { artifact, body } = await readTtsPlaybackPlanArtifact(result.planObjectKey);
  if (artifact.storageUserId && artifact.storageUserId !== scope.storageUserId) {
    return {
      result: {
        status: 'error',
        message: 'Reading plan scope mismatch.',
        retryable: false,
      },
    };
  }
  const plan = assertAuthoritativePlaybackPlan(normalizePlaybackPlan({
      ...JSON.parse(body) as Record<string, unknown>,
      planId: operation.opId,
      planObjectKey: result.planObjectKey,
      planSignature: result.planSignature,
      startOrdinal: result.startOrdinal,
      plannedCount: result.plannedCount,
    }), { documentId, readerType: scope.readerType });
  const { segments: completed } = artifact.segments.length === 0 ? { segments: [] } : await getComputeWorkerClient().listTtsPlaybackScopeCompletedSegments({
    storageUserId: scope.storageUserId,
    documentId,
    documentVersion: scope.documentVersion,
    settingsHash: planningInput.settingsHash,
    planObjectKey: result.planObjectKey,
  });
  return {
    plan,
    playback: {
      request: {
        documentId,
        settings: parsed.settings,
        planning: {
          maxBlockLength: parsed.maxBlockLength,
          language,
          ...(scope.readerType === 'pdf' ? { skipBlockKinds: parsed.skipBlockKinds } : {}),
        },
      },
      seekLayout: {
        planId: operation.opId,
        startOrdinal: 0,
        generationStartOrdinal: 0,
        status: null,
        ...buildPlaybackGrid({
          artifact,
          settingsJson: parsed.settings,
          completedDurations: new Map(completed.map((segment) => [segment.ordinal, segment.durationMs])),
          startOrdinal: 0,
        }),
      },
    },
  };
}
