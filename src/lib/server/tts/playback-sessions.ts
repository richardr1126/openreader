import { and, asc, eq, gt } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@openreader/database';
import {
  ttsSegmentEntries,
  ttsSegmentVariants,
  ttsPlaybackSessions,
} from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';
import type { TTSSegmentLocator } from '@/types/client';
import { locatorIdentityKey } from '@openreader/tts/locator';

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

type StreamPlanSegment = {
  segmentIndex: number;
  segmentKey: string | null;
  locator: TTSSegmentLocator | null;
};

async function readStreamPlanSegments(session: TtsPlaybackSessionRow): Promise<StreamPlanSegment[] | null> {
  if (!session.planObjectKey) return null;
  try {
    const cfg = getS3Config();
    const result = await getS3ProxyClient().send(new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: session.planObjectKey,
    }));
    const body = await result.Body?.transformToString();
    if (!body) return null;
    const parsed = JSON.parse(body) as { segments?: unknown[] };
    if (!Array.isArray(parsed.segments)) return null;
    return parsed.segments.map((item): StreamPlanSegment | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const segmentIndex = Number(row.segmentIndex);
      return {
        segmentIndex: Number.isFinite(segmentIndex) ? Math.max(0, Math.floor(segmentIndex)) : 0,
        segmentKey: typeof row.segmentKey === 'string' ? row.segmentKey : null,
        locator: row.locator && typeof row.locator === 'object' ? row.locator as TTSSegmentLocator : null,
      };
    }).filter((item): item is StreamPlanSegment => Boolean(item));
  } catch {
    return null;
  }
}

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
  const planSegments = await readStreamPlanSegments(session);
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
      locatorReaderRank: ttsSegmentEntries.locatorReaderRank,
      locatorPage: ttsSegmentEntries.locatorPage,
      locatorSpineIndex: ttsSegmentEntries.locatorSpineIndex,
      locatorSpineHref: ttsSegmentEntries.locatorSpineHref,
      locatorCharOffset: ttsSegmentEntries.locatorCharOffset,
      locatorLocation: ttsSegmentEntries.locatorLocation,
      locatorIdentityKey: ttsSegmentEntries.locatorIdentityKey,
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
      asc(ttsSegmentEntries.locatorReaderRank),
      asc(ttsSegmentEntries.locatorSpineIndex),
      asc(ttsSegmentEntries.locatorCharOffset),
      asc(ttsSegmentEntries.locatorSpineHref),
      asc(ttsSegmentEntries.locatorPage),
      asc(ttsSegmentEntries.locatorLocation),
      asc(ttsSegmentEntries.segmentIndex),
      asc(ttsSegmentEntries.locatorIdentityKey),
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
    locatorReaderRank: number;
    locatorPage: number;
    locatorSpineIndex: number;
    locatorSpineHref: string;
    locatorCharOffset: number;
    locatorLocation: string;
    locatorIdentityKey: string;
  }>;

  const completed = rows
    .filter((row) => Boolean(row.audioKey))
    .map((row) => ({
      sourceSegmentIndex: Number(row.ordinal),
      segmentKey: row.segmentKey,
      segmentId: row.segmentId,
      audioKey: row.audioKey!,
      durationMs: Math.max(1, Number(row.durationMs ?? 1000)),
      alignmentJson: row.alignmentJson,
      updatedAt: row.updatedAt,
      locator: locatorFromRow(row),
      locatorIdentityKey: row.locatorIdentityKey,
    }));

  // Stable ordinals: walk the plan in order, match each plan segment to a
  // completed row, and stop at the first gap. The published ordinal is the
  // plan's own `segmentIndex`, which the client uses as its playback index.
  const toRow = (row: typeof completed[number], ordinal: number): TtsPlaybackSegmentRow => ({
    ordinal,
    sourceSegmentIndex: row.sourceSegmentIndex,
    segmentKey: row.segmentKey,
    segmentId: row.segmentId,
    audioKey: row.audioKey,
    durationMs: row.durationMs,
    alignmentJson: row.alignmentJson,
    updatedAt: row.updatedAt,
    locator: row.locator,
  });

  const ordered: Array<TtsPlaybackSegmentRow> = [];
  if (planSegments && planSegments.length > 0) {
    // The canonical plan spans the whole document with absolute ordinals, but this
    // session's audio stream begins at its startOrdinal and generation runs forward
    // from there. Skip the (ungenerated) plan prefix so the contiguous-run match
    // starts at startOrdinal — otherwise it would break at ordinal 0 and yield an
    // empty timeline. The first generated segment becomes time 0 for this session.
    const startFrom = Math.max(0, Math.floor(session.startOrdinal));
    const unused = new Set(completed.map((_, index) => index));
    const take = (predicate: (row: typeof completed[number]) => boolean): typeof completed[number] | null => {
      for (const index of unused) {
        const row = completed[index];
        if (!row || !predicate(row)) continue;
        unused.delete(index);
        return row;
      }
      return null;
    };
    for (const plan of planSegments) {
      if (plan.segmentIndex < startFrom) continue;
      const planLocatorKey = locatorIdentityKey(plan.locator);
      const match = take((row) =>
        row.segmentKey === plan.segmentKey
        && row.locatorIdentityKey === planLocatorKey
        && row.sourceSegmentIndex === plan.segmentIndex
      ) ?? take((row) =>
        row.segmentKey === plan.segmentKey
        && row.locatorIdentityKey === planLocatorKey
      ) ?? take((row) =>
        row.segmentKey === plan.segmentKey
        && row.sourceSegmentIndex === plan.segmentIndex
      ) ?? take((row) =>
        row.segmentKey === plan.segmentKey
      );
      if (!match) break; // contiguous prefix: first missing plan segment ends playback timing
      ordered.push(toRow(match, plan.segmentIndex));
    }
  } else {
    completed.forEach((row, index) => ordered.push(toRow(row, index)));
  }

  return ordered
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
