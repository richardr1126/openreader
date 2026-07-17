import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  getComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import type {
  TtsPlaybackCompletedSegment,
  TtsPlaybackSessionState,
} from '@/lib/server/compute-worker/protocol';
import type { TTSSegmentLocator } from '@/types/client';

export const TTS_PLAYBACK_SESSION_TTL_MS = 30 * 60 * 1000;

export type TtsPlaybackSessionRow = TtsPlaybackSessionState & {
  workerOpId: string | null;
  createdAt: number;
};

export type TtsPlaybackSegmentRow = TtsPlaybackCompletedSegment & {
  locator: TTSSegmentLocator | null;
};

export async function resolveTtsPlaybackSession(
  request: NextRequest,
  sessionId: string,
): Promise<TtsPlaybackSessionRow | Response> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return NextResponse.json({ error: 'Missing playback session id' }, { status: 400 });
  }
  if (!isComputeWorkerAvailable()) {
    return NextResponse.json(
      { error: 'Compute worker is required for progressive TTS playback.' },
      { status: 503 },
    );
  }

  const ctxOrRes = await requireAuthContext(request);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const session = await getComputeWorkerClient().getTtsPlaybackSession(normalizedSessionId);
  if (!session || session.userId !== ctxOrRes.userId) {
    return NextResponse.json({ error: 'Playback session not found' }, { status: 404 });
  }
  if (Number(session.expiresAt) <= Date.now()) {
    return NextResponse.json({ error: 'Playback session expired' }, { status: 410 });
  }
  return {
    ...session,
    workerOpId: session.workerOpId ?? null,
    createdAt: Number(session.updatedAt ?? Date.now()),
  };
}

export async function listCompletedTtsPlaybackSegments(
  session: TtsPlaybackSessionRow,
  options?: { minOrdinal?: number; limit?: number },
): Promise<TtsPlaybackSegmentRow[]> {
  const result = await getComputeWorkerClient().listTtsPlaybackSegments({
    sessionId: session.sessionId,
    minOrdinal: Math.max(0, Math.floor(options?.minOrdinal ?? 0)),
    limit: Math.max(1, Math.min(Math.floor(options?.limit ?? 500), 10000)),
  });
  return result.segments.map((segment) => ({
    ...segment,
    locator: null,
  }));
}
