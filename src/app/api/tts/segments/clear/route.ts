import { NextRequest, NextResponse } from 'next/server';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function parseBody(value: unknown): { documentId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.documentId !== 'string' || !rec.documentId.trim()) return null;
  return { documentId: rec.documentId.trim().toLowerCase() };
}

export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/segments/clear',
    request,
  });
  try {
    const parsed = parseBody(await request.json().catch(() => null));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;

    if (!isComputeWorkerAvailable()) {
      return NextResponse.json({ error: 'Compute worker is required to clear playback cache.' }, { status: 503 });
    }
    const cleared = await new ComputeWorkerClient().clearTtsPlaybackScope({
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
      namespace: null,
    }, { signal: AbortSignal.timeout(45_000) });

    return NextResponse.json({
      documentId: parsed.documentId,
      deletedSegments: 0,
      requestedAudioObjects: cleared.deletedAudioObjects + cleared.deletedSidecarObjects,
      deletedPlaybackObjects: cleared.deletedAudioObjects + cleared.deletedSidecarObjects + cleared.deletedPlanObjects + cleared.deletedExportObjects,
      ...cleared,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      logger.warn({ event: 'tts.segments.clear_confirmation_timeout' }, 'Cache cleanup confirmation timed out');
      return NextResponse.json({
        error: 'Cleanup confirmation timed out. The cache may already be reset; cleanup may still be running. Reload the reader before trying playback again.',
      }, { status: 504 });
    }
    return errorResponse(error, {
      logger,
      event: 'tts.segments.clear_failed',
      msg: 'Failed to clear TTS segment cache',
      apiErrorMessage: 'Failed to clear TTS segment cache',
      normalize: { code: 'TTS_SEGMENTS_CLEAR_FAILED', errorClass: 'storage' },
    });
  }
}
