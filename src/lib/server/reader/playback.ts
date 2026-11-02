import type { NextRequest } from 'next/server';
import { resolveTtsLanguage } from '@openreader/tts/language';
import { resolveEffectiveOpenRouterOptions } from '@openreader/tts/openrouter';
import { normalizeSpeechText } from '@openreader/tts/speech-text';
import { effectiveVoiceCustomization } from '@openreader/tts/voice-customization';
import { resolveVoices } from '@openreader/tts/voice-resolution';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import type { ReaderPayload, ReaderPlaybackPreparation } from '@/types/reader-bootstrap';
import { mergeDocumentSettings, resolveBookVoice } from '@/lib/shared/document-settings';
import { assertAuthoritativePlaybackPlan, normalizePlaybackPlan } from '@/lib/shared/playback-plan';
import { listAdminProviders } from '@/lib/server/admin/providers';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { ComputeWorkerClient, getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type { ComputeOperation, TtsPlaybackPlanResult } from '@/lib/server/compute-worker/protocol';
import type { ComputeLimitPolicyDocument } from '@openreader/runtime-config/compute-limits';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { ComputeAdmissionLimitedError, createAdmittedComputeOperation } from '@/lib/server/compute-limits/run-admitted';
import { buildTtsPlaybackPlanningInput, toTtsPlaybackPlanRequest, type ParsedTtsPlaybackRequestBody } from '@/lib/server/tts/playback-request';
import { buildPlaybackGrid, readTtsPlaybackPlanArtifact } from '@/lib/server/tts/playback-plans';
import type { ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { resolveSpeechPreferences } from '@/lib/server/tts/speech-preferences';
import type { ReaderBootstrapResolution } from './bootstrap';

/** Resolves the playback request for a user's saved voice and document settings. */
export async function resolveDefaultPlaybackRequest(
  documentId: string,
  scope: ResolvedSegmentDocumentScope,
  settings: ReturnType<typeof mergeDocumentSettings>,
  storedPreferences: Record<string, unknown>,
  documentLanguage?: string | null,
  voiceOverride?: string,
): Promise<ParsedTtsPlaybackRequestBody | { error: string }> {
  const [runtimeConfig, providers] = await Promise.all([
    getResolvedRuntimeConfig(),
    listAdminProviders(),
  ]);
  const { normalization, preferences, provider } = resolveSpeechPreferences(storedPreferences, runtimeConfig, providers);
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
  let voice = voiceOverride || bookVoice.voice;
  // A static catalogue needs no credentials. An unconfigured installation
  // must still support reading with an estimated timeline; only generation
  // requires a configured provider.
  if (!voice && policy.voiceSource !== 'static' && normalization.sharedProviders.length > 0) {
    const credentials = await resolveTtsCredentials({
      providerHeader: provider.providerRef,
      fallbackProvider: runtimeConfig.defaultTtsProvider,
    });
    if ('error' in credentials) {
      return { error: 'The playback provider is unavailable.' };
    }
    const voices = await resolveVoices({
      provider: credentials.provider,
      model,
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
    });
    voice = voices[0] ?? policy.defaultVoices[0] ?? '';
  }
  voice ||= policy.defaultVoices[0] ?? '';
  const language = resolveTtsLanguage({
    configuredLanguage: settings.language || 'auto',
    documentLanguage,
    voice,
  });
  return {
    documentId,
    settings: {
      providerRef: provider.providerRef,
      providerType: provider.providerType,
      ttsModel: model,
      voice,
      nativeSpeed: policy.supportsNativeModelSpeed ? bookVoice.voiceSpeed : 1,
      ...(provider.providerType === 'openrouter'
        ? { ttsModelOptions: resolveEffectiveOpenRouterOptions(model, preferences.ttsModelOptions, provider.defaultModelOptions) }
        : {}),
      ...(policy.supportsInstructions && (preferences.ttsInstructions || provider.defaultInstructions)
        ? { ttsInstructions: preferences.ttsInstructions || provider.defaultInstructions }
        : {}),
      language,
      speechText: normalizeSpeechText({ ...preferences.speechText, ...settings.speechText }),
      voiceCustomization: effectiveVoiceCustomization({ ...preferences.voiceCustomization, ...settings.voiceCustomization }, provider.providerType),
    },
    startLocation: {},
    maxBlockLength: settings.playback?.maxSegmentLength ?? preferences.ttsSegmentMaxBlockLength,
    language,
    ...(scope.readerType === 'pdf'
      ? { skipBlockKinds: settings.pdf?.skipBlockKinds ?? preferences.pdfSkipBlockKinds }
      : {}),
  };
}

/** Reports the canonical plan operation for one playback request without creating one. */
export function findPlaybackPlanOperation(input: {
  parsed: ParsedTtsPlaybackRequestBody;
  scope: ResolvedSegmentDocumentScope;
  planningInput: Awaited<ReturnType<typeof buildTtsPlaybackPlanningInput>>;
}): Promise<ComputeOperation | null> {
  return new ComputeWorkerClient().resolveTtsPlaybackPlanOperation(
    toTtsPlaybackPlanRequest({ parsed: input.parsed, scope: input.scope, ...input.planningInput }),
  );
}

/** Creates or reuses the canonical plan operation for one playback request. */
export async function createAdmittedPlaybackPlanOperation(input: {
  parsed: ParsedTtsPlaybackRequestBody;
  scope: ResolvedSegmentDocumentScope;
  planningInput: Awaited<ReturnType<typeof buildTtsPlaybackPlanningInput>>;
  policy: ComputeLimitPolicyDocument;
  retryFailed?: boolean;
}): Promise<ComputeOperation> {
  const { parsed, scope, planningInput } = input;
  const client = new ComputeWorkerClient();
  const request = toTtsPlaybackPlanRequest({ parsed, scope, ...planningInput });
  const existing = await client.resolveTtsPlaybackPlanOperation(request);
  if (existing && (existing.status !== 'failed' || input.retryFailed === false)) return existing;
  return createAdmittedComputeOperation({
    policy: input.policy,
    action: 'tts_playback_plan',
    requestKey: `${parsed.documentId}:${scope.documentVersion}:${planningInput.settingsHash}`,
    subject: {
      userId: scope.userId,
      isAnonymous: scope.isAnonymousUser,
    },
    create: () => client.createTtsPlaybackPlanOperation(request),
  });
}

export async function resolveReaderPlayback(
  request: NextRequest,
  documentId: string,
  scope: ResolvedSegmentDocumentScope,
  settings: ReturnType<typeof mergeDocumentSettings>,
  storedPreferences: Record<string, unknown>,
  documentLanguage?: string | null,
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
  const parsed = await resolveDefaultPlaybackRequest(documentId, scope, settings, storedPreferences, documentLanguage);
  if ('error' in parsed) return { result: { status: 'error', message: parsed.error, retryable: true } };
  const runtimeConfig = await getResolvedRuntimeConfig();
  const planningInput = await buildTtsPlaybackPlanningInput(parsed, scope);
  let operation;
  try {
    operation = await createAdmittedPlaybackPlanOperation({
      parsed,
      scope,
      planningInput,
      policy: runtimeConfig.computeLimitPolicies,
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
          language: parsed.language,
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
