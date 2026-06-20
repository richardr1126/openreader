import { NextRequest, NextResponse } from 'next/server';
import {
  ComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import { buildTtsSegmentSettingsHash, buildTtsSegmentSettingsJson } from '@openreader/tts/segments';
import { isTtsProviderType } from '@openreader/tts/provider-catalog';
import { normalizeLanguageTag } from '@openreader/tts/language';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { getDocumentSkipBlockKinds } from '@/lib/server/tts/document-skip-kinds';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import type { TTSSegmentSettings } from '@/types/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseSettings(value: unknown): TTSSegmentSettings | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.providerRef !== 'string') return null;
  if (!isTtsProviderType(rec.providerType)) return null;
  if (typeof rec.ttsModel !== 'string') return null;
  if (typeof rec.voice !== 'string') return null;
  if (!Number.isFinite(Number(rec.nativeSpeed))) return null;
  return {
    providerRef: rec.providerRef,
    providerType: rec.providerType,
    ttsModel: rec.ttsModel,
    voice: rec.voice,
    nativeSpeed: Number(rec.nativeSpeed),
    ...(typeof rec.ttsInstructions === 'string' ? { ttsInstructions: rec.ttsInstructions } : {}),
    ...(typeof rec.language === 'string' ? { language: normalizeLanguageTag(rec.language) } : {}),
  };
}

function parseBody(value: unknown): {
  documentId: string;
  settings: TTSSegmentSettings;
  startLocation: { page?: number; spineIndex?: number; charOffset?: number };
  maxBlockLength?: number;
  language?: string;
  startSegmentKey?: string;
  startText?: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const documentId = typeof rec.documentId === 'string' ? rec.documentId.trim().toLowerCase() : '';
  const settings = parseSettings(rec.settings);
  if (!documentId || !settings) return null;

  const startRec = rec.startLocation && typeof rec.startLocation === 'object'
    ? rec.startLocation as Record<string, unknown>
    : null;
  const page = Number.isFinite(Number(startRec?.page))
    ? Math.max(1, Math.floor(Number(startRec?.page)))
    : undefined;
  const spineIndex = Number.isFinite(Number(startRec?.spineIndex))
    ? Math.max(0, Math.floor(Number(startRec?.spineIndex)))
    : undefined;
  const charOffset = Number.isFinite(Number(startRec?.charOffset))
    ? Math.max(0, Math.floor(Number(startRec?.charOffset)))
    : undefined;
  const planningRec = rec.planning && typeof rec.planning === 'object'
    ? rec.planning as Record<string, unknown>
    : null;
  const maxBlockLength = Number.isFinite(Number(planningRec?.maxBlockLength))
    ? Math.max(1, Math.floor(Number(planningRec?.maxBlockLength)))
    : undefined;
  const language = typeof planningRec?.language === 'string'
    ? normalizeLanguageTag(planningRec.language)
    : undefined;
  const startSegmentKey = typeof rec.startSegmentKey === 'string' && rec.startSegmentKey.trim()
    ? rec.startSegmentKey.trim()
    : undefined;
  const startText = typeof rec.startText === 'string' && rec.startText.trim()
    ? rec.startText.trim()
    : undefined;

  return {
    documentId,
    settings,
    startLocation: {
      ...(page ? { page } : {}),
      ...(spineIndex !== undefined ? { spineIndex } : {}),
      ...(charOffset !== undefined ? { charOffset } : {}),
    },
    ...(maxBlockLength ? { maxBlockLength } : {}),
    ...(language ? { language } : {}),
    ...(startSegmentKey ? { startSegmentKey } : {}),
    ...(startText ? { startText } : {}),
  };
}

export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/playback/plans',
    request,
  });
  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for progressive TTS playback.' },
        { status: 503 },
      );
    }

    const parsed = parseBody(await request.json().catch(() => null));
    if (!parsed) return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;

    const planExtent = scope.readerType === 'epub' ? 'section' : 'document';
    const skipBlockKinds = scope.readerType === 'pdf'
      ? await getDocumentSkipBlockKinds(parsed.documentId, scope.storageUserId)
      : [];
    const isPlainText = scope.readerType === 'html'
      ? scope.documentName.toLowerCase().endsWith('.txt')
      : false;
    const settingsHash = buildTtsSegmentSettingsHash(parsed.settings);
    const settingsJson = buildTtsSegmentSettingsJson(parsed.settings);
    const operation = await new ComputeWorkerClient().createTtsPlaybackPlanOperation({
      userId: scope.userId,
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
      settingsHash,
      settingsJson,
      startOrdinal: 0,
      planning: {
        ...(parsed.maxBlockLength ? { maxBlockLength: parsed.maxBlockLength } : {}),
        ...(parsed.language ? { language: parsed.language } : {}),
        ...(parsed.startSegmentKey ? { startSegmentKey: parsed.startSegmentKey } : {}),
        ...(parsed.startText ? { startText: parsed.startText } : {}),
        enforceSourceBoundaries: scope.readerType === 'pdf' || scope.readerType === 'epub',
        documentSource: {
          namespace: scope.testNamespace,
          skipBlockKinds,
          extent: planExtent,
          ...(scope.readerType === 'pdf' ? { startPage: parsed.startLocation.page ?? 1 } : {}),
          ...(scope.readerType === 'epub' ? { startSpineIndex: parsed.startLocation.spineIndex ?? 0 } : {}),
          ...(scope.readerType === 'epub' && parsed.startLocation.charOffset !== undefined
            ? { startCharOffset: parsed.startLocation.charOffset }
            : {}),
          isPlainText,
        },
      },
    });

    const planId = operation.opId;
    return NextResponse.json({
      planId,
      operation,
      planUrl: `/api/tts/playback/plans/${encodeURIComponent(planId)}/plan`,
      seekLayoutUrl: `/api/tts/playback/plans/${encodeURIComponent(planId)}/seek-layout`,
      eventsUrl: `/api/tts/playback/plans/${encodeURIComponent(planId)}/events`,
    }, { status: 202 });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback_plan.create_failed',
      msg: 'Failed to create TTS playback plan',
      apiErrorMessage: 'Failed to create TTS playback plan',
      normalize: { code: 'TTS_PLAYBACK_PLAN_CREATE_FAILED', errorClass: 'unknown' },
    });
  }
}
