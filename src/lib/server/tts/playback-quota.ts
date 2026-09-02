import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { rateLimiter, resolveRateLimitThresholds } from '@/lib/server/rate-limit/rate-limiter';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import { buildDailyQuotaExceededResponse } from '@/lib/server/rate-limit/problem-response';
import { readTtsPlaybackPlanArtifact } from '@/lib/server/tts/playback-plans';
import type { RuntimeConfig } from '@/lib/server/admin/settings';
import type { ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

function attachDeviceIdCookie(response: NextResponse, deviceId: string | null, didCreate: boolean): void {
  if (didCreate && deviceId) {
    setDeviceIdCookie(response, deviceId);
  }
}

function assertPlanMatchesSession(input: {
  scope: ResolvedSegmentDocumentScope;
  documentId: string;
  settingsHash: string;
  artifact: Awaited<ReturnType<typeof readTtsPlaybackPlanArtifact>>['artifact'];
}): void {
  const { artifact, scope } = input;
  if (
    artifact.storageUserId !== scope.storageUserId
    || artifact.documentId !== input.documentId
    || artifact.documentVersion !== scope.documentVersion
    || artifact.readerType !== scope.readerType
    || artifact.settingsHash !== input.settingsHash
  ) {
    throw new Error('Playback plan artifact does not match this playback session');
  }
}

export async function checkTtsPlaybackQuota(input: {
  request: NextRequest;
  scope: ResolvedSegmentDocumentScope;
  documentId: string;
  settingsHash: string;
  planObjectKey: string | undefined;
  runtimeConfig: RuntimeConfig;
}): Promise<NextResponse | null> {
  const ttsRateLimitEnabled = !input.runtimeConfig.disableTtsRateLimit;
  if (!ttsRateLimitEnabled) return null;

  if (!input.planObjectKey) {
    return NextResponse.json(
      { error: 'Playback plan is required before starting TTS synthesis' },
      { status: 400 },
    );
  }

  const { artifact } = await readTtsPlaybackPlanArtifact(input.planObjectKey);
  assertPlanMatchesSession({
    scope: input.scope,
    documentId: input.documentId,
    settingsHash: input.settingsHash,
    artifact,
  });

  const charCount = artifact.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  if (charCount <= 0) return null;

  const limits = resolveRateLimitThresholds({
    anonymous: input.runtimeConfig.ttsDailyLimitAnonymous,
    authenticated: input.runtimeConfig.ttsDailyLimitAuthenticated,
    ipAnonymous: input.runtimeConfig.ttsIpDailyLimitAnonymous,
    ipAuthenticated: input.runtimeConfig.ttsIpDailyLimitAuthenticated,
  });
  const device = input.scope.isAnonymousUser ? getOrCreateDeviceId(input.request) : null;
  const rateLimitResult = await rateLimiter.checkAndIncrementLimit(
    { id: input.scope.userId, isAnonymous: input.scope.isAnonymousUser },
    charCount,
    {
      deviceId: device?.deviceId ?? null,
      ip: getClientIp(input.request),
    },
    {
      enabled: ttsRateLimitEnabled,
      limits,
    },
  );

  if (rateLimitResult.allowed) return null;

  const response = buildDailyQuotaExceededResponse({
    rateLimitResult,
    isAnonymousUser: input.scope.isAnonymousUser,
    pathname: input.request.nextUrl.pathname,
    anonymousLimit: limits.anonymous,
    authenticatedLimit: limits.authenticated,
  });
  attachDeviceIdCookie(response, device?.deviceId ?? null, Boolean(device?.didCreate));
  return response;
}
