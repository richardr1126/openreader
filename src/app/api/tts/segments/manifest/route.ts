import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { ttsSegments } from '@/db/schema';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
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

function statusRank(status: TTSSegmentVariant['status']): number {
  if (status === 'completed') return 3;
  if (status === 'pending') return 2;
  return 1;
}

function dedupeVariants(variants: Array<{ dedupeKey: string; variant: TTSSegmentVariant }>): TTSSegmentVariant[] {
  const byKey = new Map<string, TTSSegmentVariant>();
  for (const { dedupeKey, variant } of variants) {
    const existing = byKey.get(dedupeKey);
    if (!existing) {
      byKey.set(dedupeKey, variant);
      continue;
    }
    const existingRank = statusRank(existing.status);
    const nextRank = statusRank(variant.status);
    const existingUpdatedAt = existing.updatedAt ?? 0;
    const nextUpdatedAt = variant.updatedAt ?? 0;
    if (nextRank > existingRank || (nextRank === existingRank && nextUpdatedAt >= existingUpdatedAt)) {
      byKey.set(dedupeKey, variant);
    }
  }
  return Array.from(byKey.values());
}

function locatorGroupKey(locator: TTSSegmentLocator | null): string {
  if (!locator) return 'none';
  const page = typeof locator.page === 'number' && Number.isFinite(locator.page)
    ? String(Math.floor(locator.page))
    : '';
  const location = typeof locator.location === 'string' ? locator.location : '';
  const readerType = locator.readerType || '';
  return `p:${page}|l:${location}|r:${readerType}`;
}

export async function GET(request: NextRequest) {
  try {
    const documentIdRaw = request.nextUrl.searchParams.get('documentId');
    const documentId = documentIdRaw?.trim().toLowerCase();
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
      const groupKey = `${row.segmentIndex}|${locatorGroupKey(locator)}`;

      let entry = grouped.get(groupKey);
      if (!entry) {
        entry = {
          segmentIndex: row.segmentIndex,
          locator,
          variants: [],
        };
        grouped.set(groupKey, entry);
      } else if (!entry.locator) {
        entry.locator = locator;
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

      const status: TTSSegmentVariant['status'] = row.status === 'completed' || row.status === 'error'
        ? row.status
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

    const segments = Array.from(grouped.values())
      .map((segment) => ({
        segmentIndex: segment.segmentIndex,
        locator: segment.locator,
        variants: dedupeVariants(segment.variants),
      }))
      .sort((a, b) => {
        if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
        const aPage = typeof a.locator?.page === 'number' ? a.locator.page : Number.MAX_SAFE_INTEGER;
        const bPage = typeof b.locator?.page === 'number' ? b.locator.page : Number.MAX_SAFE_INTEGER;
        if (aPage !== bPage) return aPage - bPage;
        const aLoc = a.locator?.location || '';
        const bLoc = b.locator?.location || '';
        return aLoc.localeCompare(bLoc);
      });
    const response: TTSSegmentsManifestResponse = { documentId, segments };
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error listing TTS segments manifest:', error);
    return NextResponse.json({ error: 'Failed to list TTS segments' }, { status: 500 });
  }
}
