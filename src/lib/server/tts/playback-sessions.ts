import { and, asc, eq, gt } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@openreader/database';
import {
  ttsSegmentEntries,
  ttsSegmentVariants,
  ttsPlaybackSessions,
} from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import type { TTSSegmentLocator } from '@/types/client';

export const TTS_PLAYBACK_SESSION_TTL_MS = 30 * 60 * 1000;

export type TtsPlaybackSessionRow = {
  sessionId: string;
  userId: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: string;
  status: string;
  workerOpId: string | null;
  settingsHash: string;
  settingsJson: unknown;
  startOrdinal: number;
  generationStartOrdinal: number;
  cursorOrdinal: number;
  cursorUpdatedAt: number | null;
  planObjectKey: string | null;
  expiresAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TtsPlaybackSegmentRow = {
  ordinal: number;
  sourceSegmentIndex: number;
  segmentKey: string | null;
  segmentId: string;
  audioKey: string;
  durationMs: number;
  alignmentJson: string | null;
  updatedAt: number | null;
  locator: TTSSegmentLocator | null;
};

function locatorFromRow(row: {
  locatorReaderType: string;
  locatorPage: number;
  locatorSpineIndex: number;
  locatorSpineHref: string;
  locatorCharOffset: number;
  locatorLocation: string;
}): TTSSegmentLocator | null {
  if (row.locatorReaderType === 'epub' && row.locatorSpineIndex >= 0 && row.locatorSpineHref) {
    return {
      readerType: 'epub',
      spineIndex: row.locatorSpineIndex,
      spineHref: row.locatorSpineHref,
      charOffset: Math.max(0, row.locatorCharOffset),
    };
  }
  if (row.locatorReaderType === 'pdf' && row.locatorPage >= 1) {
    return { readerType: 'pdf', page: row.locatorPage };
  }
  if (row.locatorReaderType === 'html' && row.locatorLocation) {
    return { readerType: 'html', location: row.locatorLocation };
  }
  return null;
}

export async function resolveTtsPlaybackSession(
  request: NextRequest,
  sessionId: string,
): Promise<TtsPlaybackSessionRow | Response> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return NextResponse.json({ error: 'Missing playback session id' }, { status: 400 });
  }

  const ctxOrRes = await requireAuthContext(request);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [row] = (await db
    .select()
    .from(ttsPlaybackSessions)
    .where(and(
      eq(ttsPlaybackSessions.sessionId, normalizedSessionId),
      eq(ttsPlaybackSessions.userId, ctxOrRes.userId),
    ))
    .limit(1)) as TtsPlaybackSessionRow[];

  if (!row) return NextResponse.json({ error: 'Playback session not found' }, { status: 404 });
  if (Number(row.expiresAt) <= Date.now()) {
    return NextResponse.json({ error: 'Playback session expired' }, { status: 410 });
  }
  return row;
}

export async function listCompletedTtsPlaybackSegments(
  session: TtsPlaybackSessionRow,
  options?: { minOrdinal?: number; limit?: number },
): Promise<TtsPlaybackSegmentRow[]> {
  const minOrdinal = Math.max(0, Math.floor(options?.minOrdinal ?? 0));
  const limit = Math.max(1, Math.min(Math.floor(options?.limit ?? 500), 1000));
  const rows = (await db
    .select({
      ordinal: ttsSegmentEntries.segmentIndex,
      segmentKey: ttsSegmentEntries.segmentKey,
      segmentId: ttsSegmentVariants.segmentId,
      audioKey: ttsSegmentVariants.audioKey,
      durationMs: ttsSegmentVariants.durationMs,
      alignmentJson: ttsSegmentVariants.alignmentJson,
      updatedAt: ttsSegmentVariants.updatedAt,
	      locatorReaderType: ttsSegmentEntries.locatorReaderType,
	      locatorPage: ttsSegmentEntries.locatorPage,
	      locatorSpineIndex: ttsSegmentEntries.locatorSpineIndex,
      locatorSpineHref: ttsSegmentEntries.locatorSpineHref,
      locatorCharOffset: ttsSegmentEntries.locatorCharOffset,
      locatorLocation: ttsSegmentEntries.locatorLocation,
    })
    .from(ttsSegmentEntries)
    .innerJoin(ttsSegmentVariants, and(
      eq(ttsSegmentVariants.segmentEntryId, ttsSegmentEntries.segmentEntryId),
      eq(ttsSegmentVariants.userId, ttsSegmentEntries.userId),
    ))
    .where(and(
      eq(ttsSegmentEntries.userId, session.storageUserId),
      eq(ttsSegmentEntries.documentId, session.documentId),
      eq(ttsSegmentEntries.documentVersion, session.documentVersion),
      eq(ttsSegmentVariants.settingsHash, session.settingsHash),
      eq(ttsSegmentVariants.status, 'completed'),
      gt(ttsSegmentVariants.audioKey, ''),
    ))
    .orderBy(
      asc(ttsSegmentEntries.segmentIndex),
      asc(ttsSegmentEntries.segmentEntryId),
    )
    .limit(5000)) as Array<{
    ordinal: number;
    segmentKey: string | null;
    segmentId: string;
    audioKey: string | null;
    durationMs: number | null;
    alignmentJson: string | null;
    updatedAt: number | null;
    locatorReaderType: string;
    locatorPage: number;
    locatorSpineIndex: number;
    locatorSpineHref: string;
    locatorCharOffset: number;
    locatorLocation: string;
  }>;

  return rows
    .filter((row) => Boolean(row.audioKey))
    .map((row) => ({
      ordinal: Math.max(0, Math.floor(Number(row.ordinal))),
      sourceSegmentIndex: Math.max(0, Math.floor(Number(row.ordinal))),
      segmentKey: row.segmentKey,
      segmentId: row.segmentId,
      audioKey: row.audioKey!,
      durationMs: Math.max(1, Number(row.durationMs ?? 1000)),
      alignmentJson: row.alignmentJson,
      updatedAt: row.updatedAt,
      locator: locatorFromRow(row),
    }))
    .filter((row) => row.ordinal >= minOrdinal)
    .slice(0, limit);
}

export async function resolveCompletedTtsPlaybackSegment(
  session: TtsPlaybackSessionRow,
  ordinal: number,
): Promise<TtsPlaybackSegmentRow | null> {
  const rows = await listCompletedTtsPlaybackSegments(session, { minOrdinal: ordinal, limit: 1 });
  const row = rows[0];
  return row && row.ordinal === ordinal ? row : null;
}
