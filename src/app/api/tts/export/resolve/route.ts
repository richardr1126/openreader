import { NextRequest, NextResponse } from 'next/server';
import {
  buildTtsPlaybackCanonicalSessionId,
  buildTtsPlaybackExportArtifactId,
} from '@openreader/tts/playback-scope';
import {
  ComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import type { TtsPlaybackExportProgressSummary } from '@/lib/server/compute-worker/protocol';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  buildTtsPlaybackPlanningInput,
  parseTtsPlaybackRequestBody,
  validateTtsPlaybackSessionStartOrdinal,
} from '@/lib/server/tts/playback-request';
import { TTS_PLAYBACK_SESSION_TTL_MS } from '@/lib/server/tts/playback-sessions';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { TTS_PLAYBACK_AHEAD_WINDOW } from '@/types/tts';
import {
  ComputeAdmissionLimitedError,
  createAdmittedComputeOperation,
} from '@/lib/server/compute-limits/run-admitted';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import { buildTtsPlaybackAdmissionRequestKey } from '@/lib/server/compute-limits/admission';
import {
  classifyExportArtifact,
  classifyExportGeneration,
  exportGenerationRunId,
  exportOperationIssue,
  parseTtsExportAction,
} from '@/lib/server/tts/export-state';
import type { TtsExportResolveSnapshot } from '@/types/tts-export';

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

function normalizeChapterIndex(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  // JSON numbers only: `Number("")` and `Number(false)` would select chapter 0.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : Number.NaN;
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
    const action = parseTtsExportAction(bodyRecord.action);
    const format = normalizeFormat(bodyRecord.format);
    const speed = normalizeSpeed(bodyRecord.speed);
    const chapterIndex = normalizeChapterIndex(bodyRecord.chapterIndex);
    if (Number.isNaN(chapterIndex)) {
      return NextResponse.json({ error: 'chapterIndex must be a non-negative integer' }, { status: 400 });
    }
    if (chapterIndex !== null && (action === 'retry-skipped' || action === 'stop')) {
      return NextResponse.json({ error: 'Chapter exports only support resolve and start' }, { status: 400 });
    }

    const startOrdinalError = validateTtsPlaybackSessionStartOrdinal(parsed);
    if (startOrdinalError) return NextResponse.json({ error: startOrdinalError }, { status: 400 });
    if (!parsed.planObjectKey) {
      return NextResponse.json({ error: 'Audiobook export requires a canonical planObjectKey' }, { status: 400 });
    }
    const planObjectKey = parsed.planObjectKey;

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;
    const runtimeConfig = await getRuntimeConfig();
    const device = scope.isAnonymousUser ? getOrCreateDeviceId(request) : null;
    const limitSubject = {
      userId: scope.userId,
      isAnonymous: scope.isAnonymousUser,
      deviceId: device?.deviceId ?? null,
      ip: getClientIp(request),
    };
    const { settingsHash, settingsJson, planning } = await buildTtsPlaybackPlanningInput(parsed, scope);
    const sessionScope = {
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
      settingsHash,
      planObjectKey,
      purpose: 'export-document' as const,
    };
    const sessionId = buildTtsPlaybackCanonicalSessionId(sessionScope);
    const artifactId = buildTtsPlaybackExportArtifactId({
      ...sessionScope,
      format,
      speed,
      ...(chapterIndex === null ? {} : { chapterIndex }),
    });
    const artifactScope = {
      artifactId,
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      settingsHash,
      format,
      speed,
    };

    const client = new ComputeWorkerClient();
    const readGeneration = async () => {
      const generation = await client.resolveTtsPlaybackSession(sessionScope);
      const progress: TtsPlaybackExportProgressSummary | null = generation.session
        ? await client.getTtsPlaybackExportProgress(sessionId)
        : null;
      return { generation, progress, ...classifyExportGeneration(generation) };
    };
    let current = await readGeneration();

    const runActive = current.state === 'generating' || current.state === 'queued';
    if (action === 'stop' && runActive) {
      // Stop only the run this request observed; if a newer run replaced it
      // in the meantime, the snapshot below reports that run instead.
      const observed = current.generation.session as { generationRunId?: unknown } | null;
      await client.cancelTtsPlaybackSession(
        sessionId,
        typeof observed?.generationRunId === 'string' ? observed.generationRunId : null,
      );
      current = await readGeneration();
    }

    const shouldStartGeneration = chapterIndex === null && (
      (action === 'start' && !runActive && current.state !== 'complete')
      || (action === 'retry-skipped' && !runActive && (current.progress?.skippedSegments ?? 0) > 0)
    );
    if (shouldStartGeneration) {
      const now = Date.now();
      await createAdmittedComputeOperation({
        policy: runtimeConfig.computeLimitPolicies,
        action: 'tts_playback_document',
        requestKey: buildTtsPlaybackAdmissionRequestKey(sessionId, now),
        subject: limitSubject,
        create: () => client.createTtsPlaybackOperation({
          sessionId,
          userId: scope.userId,
          storageUserId: scope.storageUserId,
          documentId: parsed.documentId,
          documentVersion: scope.documentVersion,
          readerType: scope.readerType,
          settingsHash,
          settingsJson,
          planObjectKey,
          expiresAt: now + TTS_PLAYBACK_SESSION_TTL_MS,
          aheadWindow: TTS_PLAYBACK_AHEAD_WINDOW,
          backgroundExtent: 'document',
          generationExtent: 'document',
          // A new run id per observed state supersedes a stopped run that is
          // still draining, while concurrent duplicate starts share one run.
          generationRunId: exportGenerationRunId({
            sessionId,
            action,
            session: current.generation.session,
          }),
          ...(action === 'retry-skipped' ? { retryErroredSegments: true } : {}),
          planning,
        }),
      });
      current = await readGeneration();
    }

    const chapter = chapterIndex === null ? null : current.progress?.chapters[chapterIndex] ?? null;
    if (chapterIndex !== null && current.progress && !chapter) {
      return NextResponse.json({ error: 'Chapter not found in this export' }, { status: 404 });
    }
    const counts = chapter ?? (current.progress
      ? { completedSegments: current.progress.completedSegments, skippedSegments: current.progress.skippedSegments }
      : null);
    // A whole book needs a finished run; one chapter only needs its own
    // segments settled, so it can be downloaded while generation continues.
    const settled = chapter
      ? chapter.completedSegments > 0
        && chapter.completedSegments + chapter.skippedSegments === chapter.plannedSegments
      : current.state === 'complete';

    let artifact = await client.resolveTtsPlaybackExportArtifact(artifactScope);
    let artifactState = classifyExportArtifact({ artifact, counts });
    if (action === 'start' && settled && artifactState !== 'ready' && artifactState !== 'building') {
      await createAdmittedComputeOperation({
        policy: runtimeConfig.computeLimitPolicies,
        action: 'tts_playback_export',
        requestKey: artifactId,
        subject: limitSubject,
        create: () => client.createTtsPlaybackExportArtifactOperation({
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
          ...(chapterIndex === null ? {} : { chapterIndex }),
        }),
      });
      artifact = await client.resolveTtsPlaybackExportArtifact(artifactScope);
      artifactState = classifyExportArtifact({ artifact, counts });
    }

    const snapshot: TtsExportResolveSnapshot = {
      sessionId,
      artifactId,
      chapterIndex,
      generation: {
        state: current.state,
        operationId: current.generation.operation?.opId ?? null,
        issue: current.issue,
      },
      progress: current.progress ? {
        plannedSegments: current.progress.plannedSegments,
        completedSegments: current.progress.completedSegments,
        skippedSegments: current.progress.skippedSegments,
        lastSkipIssue: current.progress.lastSkipError,
        chapters: current.progress.chapters,
      } : null,
      artifact: {
        state: artifactState,
        operationId: artifact.operation?.opId ?? null,
        issue: artifactState === 'failed' ? exportOperationIssue(artifact.operation) : null,
      },
      download: artifactState === 'ready' && artifact.artifact
        ? {
          url: `/api/tts/export/download?artifactId=${encodeURIComponent(artifactId)}&documentId=${encodeURIComponent(parsed.documentId)}`,
          filename: artifact.artifact.dispositionFilename,
        }
        : null,
    };
    const response = NextResponse.json(snapshot);
    if (device?.didCreate) setDeviceIdCookie(response, device.deviceId);
    return response;
  } catch (error) {
    if (error instanceof ComputeAdmissionLimitedError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryAfterMs: error.retryAfterMs,
      }, {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) },
      });
    }
    return errorResponse(error, {
      logger,
      event: 'tts.export.resolve_failed',
      msg: 'Failed to resolve audiobook export',
      apiErrorMessage: 'Failed to resolve audiobook export',
      normalize: { code: 'TTS_EXPORT_RESOLVE_FAILED', errorClass: 'unknown' },
    });
  }
}
