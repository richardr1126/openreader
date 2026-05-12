import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { ttsSegments } from '@/db/schema';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import {
  compareManifestSegments,
  decodeManifestCursor,
  dedupeManifestVariants,
  encodeManifestCursor,
  locatorIdentityKey,
  parseManifestPageSize,
} from '@/lib/server/tts/segments-manifest';
import type {
  TTSSegmentLocator,
  TTSSegmentRow,
  TTSSegmentSettings,
  TTSSegmentVariant,
  TTSSegmentsManifestResponse,
} from '@/types/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseSettingsValue(value: unknown): TTSSegmentSettings | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  // Settings stored via buildTtsSegmentSettingsJson — accept either the runtime
  // shape (ttsProvider/ttsModel/voice/nativeSpeed/ttsInstructions) or the
  // canonical hash form (provider/model/voice/speed/instructions/format).
  const ttsProvider = typeof rec.ttsProvider === 'string'
    ? rec.ttsProvider
    : typeof rec.provider === 'string' ? rec.provider : null;
  const ttsModel = typeof rec.ttsModel === 'string'
    ? rec.ttsModel
    : typeof rec.model === 'string' ? rec.model : null;
  const voice = typeof rec.voice === 'string' ? rec.voice : null;
  const speedSource = rec.nativeSpeed ?? rec.speed;
  const nativeSpeed = Number.isFinite(Number(speedSource)) ? Number(speedSource) : 1;
  const instructionsSource = rec.ttsInstructions ?? rec.instructions;
  const ttsInstructions = typeof instructionsSource === 'string' ? instructionsSource : '';

  if (!ttsProvider || !ttsModel || !voice) return null;
  return { ttsProvider, ttsModel, voice, nativeSpeed, ttsInstructions };
}

function parseLocator(value: unknown): TTSSegmentLocator | null {
  if (!value) return null;
  if (typeof value !== 'string') return value as TTSSegmentLocator;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as TTSSegmentLocator;
  } catch {
    return null;
  }
}

function buildSegmentAudioUrls(documentId: string, segmentId: string): {
  audioPresignUrl: string;
  audioFallbackUrl: string;
} {
  const encodedDocumentId = encodeURIComponent(documentId);
  const encodedSegmentId = encodeURIComponent(segmentId);
  return {
    audioPresignUrl: `/api/tts/segments/audio/presign?documentId=${encodedDocumentId}&segmentId=${encodedSegmentId}`,
    audioFallbackUrl: `/api/tts/segments/audio/fallback?documentId=${encodedDocumentId}&segmentId=${encodedSegmentId}`,
  };
}

function isAbortLikeMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /abort/i.test(message);
}

export async function GET(request: NextRequest) {
  try {
    const documentIdRaw = request.nextUrl.searchParams.get('documentId');
    const documentId = documentIdRaw?.trim().toLowerCase();
    const limit = parseManifestPageSize(request.nextUrl.searchParams.get('limit'));
    const cursor = decodeManifestCursor(request.nextUrl.searchParams.get('cursor'));
    if (!documentId) {
      return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, documentId);
    if (scope instanceof Response) return scope;

    const rows = (await db
      .select()
      .from(ttsSegments)
      .where(and(
        eq(ttsSegments.userId, scope.storageUserId),
        eq(ttsSegments.documentId, documentId),
        eq(ttsSegments.documentVersion, scope.documentVersion),
      ))
      .orderBy(asc(ttsSegments.segmentIndex), asc(ttsSegments.updatedAt))) as Array<{
      segmentId: string;
      userId: string;
      documentId: string;
      readerType: string;
      documentVersion: number;
      segmentIndex: number;
      segmentKey: string | null;
      locatorJson: string | null;
      settingsHash: string;
      settingsJson: unknown;
      textHash: string;
      textLength: number;
      audioKey: string | null;
      audioFormat: string;
      durationMs: number | null;
      alignmentJson: string | null;
      status: string;
      error: string | null;
      createdAt: number | null;
      updatedAt: number | null;
    }>;

    const grouped = new Map<string, Omit<TTSSegmentRow, 'variants'> & {
      variants: Array<{ dedupeKey: string; variant: TTSSegmentVariant }>;
    }>();

    for (const row of rows) {
      const locator = parseLocator(row.locatorJson);
      // Use the per-row identity key (not the coarse sidebar group key) so two
      // persisted rows in the same chapter at different `charOffset`s remain
      // distinct entries instead of collapsing into one bucket whose locator
      // only reflects the first row seen.
      const groupKey = `${row.segmentIndex}|${locatorIdentityKey(locator)}`;

      let entry = grouped.get(groupKey);
      if (!entry) {
        entry = {
          segmentIndex: row.segmentIndex,
          segmentKey: row.segmentKey,
          locator,
          variants: [],
        };
        grouped.set(groupKey, entry);
      } else {
        if (!entry.locator) entry.locator = locator;
        if (!entry.segmentKey && row.segmentKey) entry.segmentKey = row.segmentKey;
      }

      let alignmentWordCount = 0;
      if (row.alignmentJson) {
        try {
          const parsed = JSON.parse(row.alignmentJson) as { words?: unknown[] };
          alignmentWordCount = Array.isArray(parsed?.words) ? parsed.words.length : 0;
        } catch {
          alignmentWordCount = 0;
        }
      }

      const status: TTSSegmentVariant['status'] = row.status === 'completed'
        ? 'completed'
        : row.status === 'error' && !isAbortLikeMessage(row.error)
          ? 'error'
          : 'pending';

      const audioUrls = row.status === 'completed' && row.audioKey
        ? buildSegmentAudioUrls(documentId, row.segmentId)
        : { audioPresignUrl: null, audioFallbackUrl: null };

      entry.variants.push({
        dedupeKey: `settings:${row.settingsHash}`,
        variant: {
          segmentId: row.segmentId,
          settings: parseSettingsValue(row.settingsJson),
          audioPresignUrl: audioUrls.audioPresignUrl,
          audioFallbackUrl: audioUrls.audioFallbackUrl,
          durationMs: row.durationMs,
          status,
          textLength: row.textLength,
          alignmentWordCount,
          audioKey: row.audioKey,
          updatedAt: row.updatedAt,
        },
      });
    }

    const segments = Array.from(grouped.entries())
      .map(([groupKey, segment]) => ({
        groupKey,
        segmentIndex: segment.segmentIndex,
        segmentKey: segment.segmentKey,
        locator: segment.locator,
        variants: dedupeManifestVariants(segment.variants),
      }))
      .sort(compareManifestSegments);

    let startIndex = 0;
    if (cursor) {
      const cursorIndex = segments.findIndex((segment) => segment.groupKey === cursor);
      if (cursorIndex < 0) {
        return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
      }
      if (cursorIndex >= 0) startIndex = cursorIndex + 1;
    }

    const page = segments.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < segments.length;
    const nextCursor = hasMore && page.length > 0
      ? encodeManifestCursor(page[page.length - 1].groupKey)
      : null;

    const response: TTSSegmentsManifestResponse = {
      documentId,
      segments: page.map((segment) => ({
        segmentIndex: segment.segmentIndex,
        segmentKey: segment.segmentKey ?? null,
        locator: segment.locator,
        variants: segment.variants,
      })),
      nextCursor,
      hasMore,
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error listing TTS segments manifest:', error);
    return NextResponse.json({ error: 'Failed to list TTS segments' }, { status: 500 });
  }
}
