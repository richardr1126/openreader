import { NextRequest, NextResponse } from 'next/server';
import {
  buildTtsPlaybackCanonicalSessionId,
  buildTtsPlaybackExportArtifactId,
} from '@openreader/tts/playback-scope';
import {
  ComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { checkTtsPlaybackQuota } from '@/lib/server/tts/playback-quota';
import {
  buildTtsPlaybackPlanningInput,
  parseTtsPlaybackRequestBody,
  validateTtsPlaybackSessionStartOrdinal,
} from '@/lib/server/tts/playback-request';
import { TTS_PLAYBACK_SESSION_TTL_MS } from '@/lib/server/tts/playback-sessions';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { TTS_PLAYBACK_AHEAD_WINDOW } from '@/types/tts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ExportFormat = 'mp3' | 'm4b';

function normalizeSpeed(value: unknown): number {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return 1;
  return Math.max(0.5, Math.min(3, speed));
}

function normalizeFormat(value: unknown): ExportFormat {
  return value === 'm4b' ? 'm4b' : 'mp3';
}

export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/export/resolve',
    request,
  });
  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for audiobook export.' },
        { status: 503 },
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = parseTtsPlaybackRequestBody(body);
    if (!parsed) return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    const bodyRecord = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const start = bodyRecord.start === true;
    const format = normalizeFormat(bodyRecord.format);
    const speed = normalizeSpeed(bodyRecord.speed);

    const startOrdinalError = validateTtsPlaybackSessionStartOrdinal(parsed);
    if (startOrdinalError) return NextResponse.json({ error: startOrdinalError }, { status: 400 });
    if (!parsed.planObjectKey) {
      return NextResponse.json({ error: 'Audiobook export requires a canonical planObjectKey' }, { status: 400 });
    }
    const planObjectKey = parsed.planObjectKey;

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;
    const runtimeConfig = await getRuntimeConfig();
    const { settingsHash, settingsJson, planning } = await buildTtsPlaybackPlanningInput(parsed, scope);
    const sessionId = buildTtsPlaybackCanonicalSessionId({
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
      settingsHash,
      planObjectKey,
      purpose: 'export-document',
    });
    const artifactId = buildTtsPlaybackExportArtifactId({
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
      settingsHash,
      planObjectKey,
      format,
      speed,
    });

    const client = new ComputeWorkerClient();
    let generation = await client.resolveTtsPlaybackSession({
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
      settingsHash,
      planObjectKey,
      purpose: 'export-document',
    });

    const generationStatus = generation.operation?.status ?? (generation.session as { status?: string } | null)?.status ?? null;
    const shouldCreateGeneration = start
      && (!generation.session || generationStatus === 'failed');
    if (shouldCreateGeneration) {
      const quotaResponse = await checkTtsPlaybackQuota({
        request,
        scope,
        documentId: parsed.documentId,
        settingsHash,
        planObjectKey,
        runtimeConfig,
      });
      if (quotaResponse) return quotaResponse;

      const now = Date.now();
      const expiresAt = now + TTS_PLAYBACK_SESSION_TTL_MS;
      await client.createTtsPlaybackOperation({
        sessionId,
        userId: scope.userId,
        storageUserId: scope.storageUserId,
        documentId: parsed.documentId,
        documentVersion: scope.documentVersion,
        readerType: scope.readerType,
        settingsHash,
        settingsJson,
        planObjectKey,
        expiresAt,
        aheadWindow: TTS_PLAYBACK_AHEAD_WINDOW,
        backgroundExtent: 'document',
        generationExtent: 'document',
        planning,
      });
      generation = await client.resolveTtsPlaybackSession({
        storageUserId: scope.storageUserId,
        documentId: parsed.documentId,
        documentVersion: scope.documentVersion,
        readerType: scope.readerType,
        settingsHash,
        planObjectKey,
        purpose: 'export-document',
      });
    }

    let artifact = await client.resolveTtsPlaybackExportArtifact({
      artifactId,
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      settingsHash,
      format,
      speed,
    });

    if (
      start
      && generationStatus === 'succeeded'
      && !artifact.artifact
      && (!artifact.operation || artifact.operation.status === 'failed' || artifact.operation.status === 'succeeded')
    ) {
      await client.createTtsPlaybackExportArtifactOperation({
        artifactId,
        sessionId,
        userId: scope.userId,
        storageUserId: scope.storageUserId,
        documentId: parsed.documentId,
        documentVersion: scope.documentVersion,
        readerType: scope.readerType,
        settingsHash,
        settingsJson,
        planObjectKey,
        format,
        speed,
      });
      artifact = await client.resolveTtsPlaybackExportArtifact({
        artifactId,
        storageUserId: scope.storageUserId,
        documentId: parsed.documentId,
        documentVersion: scope.documentVersion,
        settingsHash,
        format,
        speed,
      });
    }

    const downloadUrl = artifact.artifact
      ? `/api/tts/export/download?artifactId=${encodeURIComponent(artifactId)}&documentId=${encodeURIComponent(parsed.documentId)}`
      : null;

    return NextResponse.json({
      sessionId,
      artifactId,
      generation,
      artifact,
      downloadUrl,
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.export.resolve_failed',
      msg: 'Failed to resolve audiobook export',
      apiErrorMessage: 'Failed to resolve audiobook export',
      normalize: { code: 'TTS_EXPORT_RESOLVE_FAILED', errorClass: 'unknown' },
    });
  }
}
