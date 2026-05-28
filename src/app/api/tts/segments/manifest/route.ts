import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, gt, inArray, or } from 'drizzle-orm';
import { db } from '@/db';
import { ttsSegmentEntries, ttsSegmentVariants } from '@/db/schema';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import {
  decodeManifestCursor,
  dedupeManifestVariants,
  encodeManifestCursor,
  parseManifestPageSize,
  type TTSSegmentManifestCursor,
} from '@/lib/server/tts/segments-manifest';
import type {
  TTSSegmentLocator,
  TTSSegmentRow,
  TTSSegmentSettings,
  TTSSegmentVariant,
  TTSSegmentsManifestResponse,
} from '@/types/client';
import { isTtsProviderType } from '@/lib/shared/tts-provider-catalog';
import { resolveEffectiveProviderType } from '@/lib/shared/tts-provider-policy';
import { resolveSegmentAudioUrls } from '@/lib/server/tts/segment-audio-urls';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ManifestGroupRow = {
  segmentEntryId: string;
  segmentIndex: number;
  segmentKey: string | null;
  textLength: number;
  locatorReaderRank: number;
  locatorReaderType: string;
  locatorPage: number;
  locatorSpineIndex: number;
  locatorSpineHref: string;
  locatorCharOffset: number;
  locatorLocation: string;
  locatorIdentityKey: string;
};

function parseSettingsValue(value: unknown): TTSSegmentSettings | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  // Accept both current settings shape and canonicalized legacy keys from
  // persisted rows (e.g., SQLite stringified settings with `model/speed`).
  const providerRef = typeof rec.providerRef === 'string'
    ? rec.providerRef
    : typeof rec.ttsProvider === 'string'
      ? rec.ttsProvider
      : typeof rec.provider === 'string'
        ? rec.provider
        : null;
  const providerType = isTtsProviderType(rec.providerType)
    ? rec.providerType
    : resolveEffectiveProviderType({ providerRef });
  const ttsModel = typeof rec.ttsModel === 'string'
    ? rec.ttsModel
    : typeof rec.model === 'string'
      ? rec.model
      : null;
  const voice = typeof rec.voice === 'string' ? rec.voice : null;
  const speedSource = rec.nativeSpeed ?? rec.speed;
  const nativeSpeed = Number.isFinite(Number(speedSource)) ? Number(speedSource) : 1;
  const instructionsSource = rec.ttsInstructions ?? rec.instructions;
  const ttsInstructions = typeof instructionsSource === 'string' ? instructionsSource : '';

  if (!providerRef || !providerType || !ttsModel || !voice) return null;
  return { providerRef, providerType, ttsModel, voice, nativeSpeed, ttsInstructions };
}

function locatorFromProjection(row: ManifestGroupRow): TTSSegmentLocator | null {
  if (row.locatorReaderType === 'epub' && row.locatorSpineIndex >= 0 && row.locatorCharOffset >= 0 && row.locatorSpineHref) {
    return {
      readerType: 'epub',
      spineIndex: row.locatorSpineIndex,
      spineHref: row.locatorSpineHref,
      charOffset: row.locatorCharOffset,
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

function isAbortLikeMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /abort/i.test(message);
}

function buildKeysetWhere(cursor: TTSSegmentManifestCursor) {
  return or(
    gt(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
    and(
      eq(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
      gt(ttsSegmentEntries.locatorSpineIndex, cursor.locatorSpineIndex),
    ),
    and(
      eq(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
      eq(ttsSegmentEntries.locatorSpineIndex, cursor.locatorSpineIndex),
      gt(ttsSegmentEntries.locatorCharOffset, cursor.locatorCharOffset),
    ),
    and(
      eq(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
      eq(ttsSegmentEntries.locatorSpineIndex, cursor.locatorSpineIndex),
      eq(ttsSegmentEntries.locatorCharOffset, cursor.locatorCharOffset),
      gt(ttsSegmentEntries.locatorSpineHref, cursor.locatorSpineHref),
    ),
    and(
      eq(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
      eq(ttsSegmentEntries.locatorSpineIndex, cursor.locatorSpineIndex),
      eq(ttsSegmentEntries.locatorCharOffset, cursor.locatorCharOffset),
      eq(ttsSegmentEntries.locatorSpineHref, cursor.locatorSpineHref),
      gt(ttsSegmentEntries.locatorPage, cursor.locatorPage),
    ),
    and(
      eq(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
      eq(ttsSegmentEntries.locatorSpineIndex, cursor.locatorSpineIndex),
      eq(ttsSegmentEntries.locatorCharOffset, cursor.locatorCharOffset),
      eq(ttsSegmentEntries.locatorSpineHref, cursor.locatorSpineHref),
      eq(ttsSegmentEntries.locatorPage, cursor.locatorPage),
      gt(ttsSegmentEntries.locatorLocation, cursor.locatorLocation),
    ),
    and(
      eq(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
      eq(ttsSegmentEntries.locatorSpineIndex, cursor.locatorSpineIndex),
      eq(ttsSegmentEntries.locatorCharOffset, cursor.locatorCharOffset),
      eq(ttsSegmentEntries.locatorSpineHref, cursor.locatorSpineHref),
      eq(ttsSegmentEntries.locatorPage, cursor.locatorPage),
      eq(ttsSegmentEntries.locatorLocation, cursor.locatorLocation),
      gt(ttsSegmentEntries.segmentIndex, cursor.segmentIndex),
    ),
    and(
      eq(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
      eq(ttsSegmentEntries.locatorSpineIndex, cursor.locatorSpineIndex),
      eq(ttsSegmentEntries.locatorCharOffset, cursor.locatorCharOffset),
      eq(ttsSegmentEntries.locatorSpineHref, cursor.locatorSpineHref),
      eq(ttsSegmentEntries.locatorPage, cursor.locatorPage),
      eq(ttsSegmentEntries.locatorLocation, cursor.locatorLocation),
      eq(ttsSegmentEntries.segmentIndex, cursor.segmentIndex),
      gt(ttsSegmentEntries.locatorIdentityKey, cursor.locatorIdentityKey),
    ),
    and(
      eq(ttsSegmentEntries.locatorReaderRank, cursor.locatorReaderRank),
      eq(ttsSegmentEntries.locatorSpineIndex, cursor.locatorSpineIndex),
      eq(ttsSegmentEntries.locatorCharOffset, cursor.locatorCharOffset),
      eq(ttsSegmentEntries.locatorSpineHref, cursor.locatorSpineHref),
      eq(ttsSegmentEntries.locatorPage, cursor.locatorPage),
      eq(ttsSegmentEntries.locatorLocation, cursor.locatorLocation),
      eq(ttsSegmentEntries.segmentIndex, cursor.segmentIndex),
      eq(ttsSegmentEntries.locatorIdentityKey, cursor.locatorIdentityKey),
      gt(ttsSegmentEntries.segmentEntryId, cursor.segmentEntryId),
    ),
  );
}

function cursorFromGroupRow(row: ManifestGroupRow): TTSSegmentManifestCursor {
  return {
    locatorReaderRank: row.locatorReaderRank,
    locatorSpineIndex: row.locatorSpineIndex,
    locatorCharOffset: row.locatorCharOffset,
    locatorSpineHref: row.locatorSpineHref,
    locatorPage: row.locatorPage,
    locatorLocation: row.locatorLocation,
    segmentIndex: row.segmentIndex,
    locatorIdentityKey: row.locatorIdentityKey,
    segmentEntryId: row.segmentEntryId,
  };
}

export async function GET(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/segments/manifest',
    request,
  });
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

    const scopeWhere = and(
      eq(ttsSegmentEntries.userId, scope.storageUserId),
      eq(ttsSegmentEntries.documentId, documentId),
      eq(ttsSegmentEntries.documentVersion, scope.documentVersion),
    );

    const groupWhere = cursor
      ? and(scopeWhere, buildKeysetWhere(cursor))
      : scopeWhere;

    const groupedRows = (await db
      .select({
        segmentEntryId: ttsSegmentEntries.segmentEntryId,
        segmentIndex: ttsSegmentEntries.segmentIndex,
        segmentKey: ttsSegmentEntries.segmentKey,
        textLength: ttsSegmentEntries.textLength,
        locatorReaderRank: ttsSegmentEntries.locatorReaderRank,
        locatorReaderType: ttsSegmentEntries.locatorReaderType,
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
      .where(groupWhere)
      .groupBy(
        ttsSegmentEntries.segmentEntryId,
        ttsSegmentEntries.segmentIndex,
        ttsSegmentEntries.segmentKey,
        ttsSegmentEntries.textLength,
        ttsSegmentEntries.locatorReaderRank,
        ttsSegmentEntries.locatorReaderType,
        ttsSegmentEntries.locatorPage,
        ttsSegmentEntries.locatorSpineIndex,
        ttsSegmentEntries.locatorSpineHref,
        ttsSegmentEntries.locatorCharOffset,
        ttsSegmentEntries.locatorLocation,
        ttsSegmentEntries.locatorIdentityKey,
      )
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
      .limit(limit + 1)) as ManifestGroupRow[];

    const hasMore = groupedRows.length > limit;
    const pageGroups = hasMore ? groupedRows.slice(0, limit) : groupedRows;
    if (pageGroups.length === 0) {
      const emptyResponse: TTSSegmentsManifestResponse = {
        documentId,
        segments: [],
        nextCursor: null,
        hasMore: false,
      };
      return NextResponse.json(emptyResponse);
    }

    const entryIds = pageGroups.map((row) => row.segmentEntryId);
    const entryById = new Map(pageGroups.map((entry) => [entry.segmentEntryId, entry]));

    const variantRows = (await db
      .select()
      .from(ttsSegmentVariants)
      .where(and(
        eq(ttsSegmentVariants.userId, scope.storageUserId),
        inArray(ttsSegmentVariants.segmentEntryId, entryIds),
      ))
      .orderBy(asc(ttsSegmentVariants.segmentEntryId), asc(ttsSegmentVariants.updatedAt))) as Array<{
      segmentId: string;
      userId: string;
      segmentEntryId: string;
      settingsHash: string;
      settingsJson: unknown;
      audioKey: string | null;
      audioFormat: string;
      durationMs: number | null;
      alignmentJson: string | null;
      status: string;
      error: string | null;
      createdAt: number | null;
      updatedAt: number | null;
    }>;

    const audioUrlsBySegmentId = new Map<string, { audioPresignUrl: string | null; audioFallbackUrl: string | null }>();
    await Promise.all(
      variantRows.map(async (row) => {
        if (row.status !== 'completed' || !row.audioKey) return;
        const urls = await resolveSegmentAudioUrls({
          documentId,
          segmentId: row.segmentId,
          audioKey: row.audioKey,
        });
        audioUrlsBySegmentId.set(row.segmentId, urls);
      }),
    );

    const grouped = new Map<string, Omit<TTSSegmentRow, 'variants'> & {
      variants: Array<{ dedupeKey: string; variant: TTSSegmentVariant }>;
    }>();

    for (const row of variantRows) {
      const entryMeta = entryById.get(row.segmentEntryId);
      if (!entryMeta) continue;
      const key = row.segmentEntryId;
      const locator = locatorFromProjection(entryMeta);

      let entry = grouped.get(key);
      if (!entry) {
        entry = {
          segmentIndex: entryMeta.segmentIndex,
          segmentKey: entryMeta.segmentKey,
          locator,
          variants: [],
        };
        grouped.set(key, entry);
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
        ? (audioUrlsBySegmentId.get(row.segmentId) ?? { audioPresignUrl: null, audioFallbackUrl: null })
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
          textLength: entryMeta.textLength,
          alignmentWordCount,
          audioKey: row.audioKey,
          updatedAt: row.updatedAt,
        },
      });
    }

    const segments = pageGroups
      .map((row) => {
        const key = row.segmentEntryId;
        const entry = grouped.get(key);
        return {
          segmentIndex: row.segmentIndex,
          segmentKey: row.segmentKey ?? null,
          locator: entry?.locator || locatorFromProjection(row),
          variants: dedupeManifestVariants(entry?.variants || []),
        };
      });

    const nextCursor = hasMore
      ? encodeManifestCursor(cursorFromGroupRow(pageGroups[pageGroups.length - 1]))
      : null;

    const response: TTSSegmentsManifestResponse = {
      documentId,
      segments,
      nextCursor,
      hasMore,
    };
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.segments.manifest.list_failed',
      msg: 'Failed to list TTS segments',
      apiErrorMessage: 'Failed to list TTS segments',
      normalize: { code: 'TTS_SEGMENTS_MANIFEST_LIST_FAILED', errorClass: 'db' },
    });
  }
}
