import { buildTtsSegmentSettingsHash, buildTtsSegmentSettingsJson } from '@openreader/tts/segments';
import { isTtsProviderType } from '@openreader/tts/provider-catalog';
import { normalizeLanguageTag } from '@openreader/tts/language';
import { getDocumentSkipBlockKinds } from '@/lib/server/tts/document-skip-kinds';
import type { TtsPlaybackPlanRequest, TtsPlaybackRequest } from '@/lib/server/compute-worker/protocol';
import type { ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import type { TTSSegmentSettings } from '@/types/client';

type PlaybackStartLocation = {
  page?: number;
  spineIndex?: number;
  charOffset?: number;
};

export type ParsedTtsPlaybackRequestBody = {
  documentId: string;
  settings: TTSSegmentSettings;
  startLocation: PlaybackStartLocation;
  maxBlockLength?: number;
  language?: string;
  startSegmentKey?: string;
  startText?: string;
  planObjectKey?: string;
  planSignature?: string;
  planId?: string;
};

function readOptionalInt(
  record: Record<string, unknown>,
  key: string,
  min: number,
): number | undefined | null {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized < min ? min : normalized;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined | null {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseSettings(value: unknown): TTSSegmentSettings | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.providerRef !== 'string') return null;
  if (!isTtsProviderType(rec.providerType)) return null;
  if (typeof rec.ttsModel !== 'string') return null;
  if (typeof rec.voice !== 'string') return null;
  if (typeof rec.nativeSpeed !== 'number' || !Number.isFinite(rec.nativeSpeed)) return null;
  if (rec.ttsInstructions !== undefined && typeof rec.ttsInstructions !== 'string') return null;
  if (rec.language !== undefined && typeof rec.language !== 'string') return null;
  return {
    providerRef: rec.providerRef,
    providerType: rec.providerType,
    ttsModel: rec.ttsModel,
    voice: rec.voice,
    nativeSpeed: rec.nativeSpeed,
    ...(typeof rec.ttsInstructions === 'string' ? { ttsInstructions: rec.ttsInstructions } : {}),
    ...(typeof rec.language === 'string' ? { language: normalizeLanguageTag(rec.language) } : {}),
  };
}

export function parseTtsPlaybackRequestBody(value: unknown): ParsedTtsPlaybackRequestBody | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const documentId = typeof rec.documentId === 'string' ? rec.documentId.trim().toLowerCase() : '';
  const settings = parseSettings(rec.settings);
  if (!documentId || !settings) return null;

  const startRec = rec.startLocation === undefined
    ? {}
    : rec.startLocation && typeof rec.startLocation === 'object'
      ? rec.startLocation as Record<string, unknown>
      : null;
  if (!startRec) return null;
  const page = readOptionalInt(startRec, 'page', 1);
  const spineIndex = readOptionalInt(startRec, 'spineIndex', 0);
  const charOffset = readOptionalInt(startRec, 'charOffset', 0);
  if (page === null || spineIndex === null || charOffset === null) return null;

  const planningRec = rec.planning === undefined
    ? {}
    : rec.planning && typeof rec.planning === 'object'
      ? rec.planning as Record<string, unknown>
      : null;
  if (!planningRec) return null;
  const maxBlockLength = readOptionalInt(planningRec, 'maxBlockLength', 1);
  if (maxBlockLength === null) return null;
  const planningLanguage = readOptionalString(planningRec, 'language');
  if (planningLanguage === null) return null;

  const startSegmentKey = readOptionalString(rec, 'startSegmentKey');
  const startText = readOptionalString(rec, 'startText');
  const planObjectKey = readOptionalString(rec, 'planObjectKey');
  const planSignature = readOptionalString(rec, 'planSignature');
  const planId = readOptionalString(rec, 'planId');
  if (
    startSegmentKey === null
    || startText === null
    || planObjectKey === null
    || planSignature === null
    || planId === null
  ) {
    return null;
  }

  return {
    documentId,
    settings,
    startLocation: {
      ...(page !== undefined ? { page } : {}),
      ...(spineIndex !== undefined ? { spineIndex } : {}),
      ...(charOffset !== undefined ? { charOffset } : {}),
    },
    ...(maxBlockLength !== undefined ? { maxBlockLength } : {}),
    ...(planningLanguage ? { language: normalizeLanguageTag(planningLanguage) } : {}),
    ...(startSegmentKey ? { startSegmentKey } : {}),
    ...(startText ? { startText } : {}),
    ...(planObjectKey ? { planObjectKey } : {}),
    ...(planSignature ? { planSignature } : {}),
    ...(planId ? { planId } : {}),
  };
}

export function validateTtsPlaybackStartLocation(
  parsed: ParsedTtsPlaybackRequestBody,
  scope: ResolvedSegmentDocumentScope,
): string | null {
  if (
    scope.readerType === 'epub'
    && (
      typeof parsed.startLocation.spineIndex !== 'number'
      || typeof parsed.startLocation.charOffset !== 'number'
    )
  ) {
    return 'EPUB playback start requires stable spine coordinates';
  }
  return null;
}

export async function buildTtsPlaybackPlanningInput(
  parsed: ParsedTtsPlaybackRequestBody,
  scope: ResolvedSegmentDocumentScope,
): Promise<{
  settingsHash: string;
  settingsJson: string;
  planning: TtsPlaybackRequest['planning'];
}> {
  const settingsHash = buildTtsSegmentSettingsHash(parsed.settings);
  const rawSettingsJson = buildTtsSegmentSettingsJson(parsed.settings);
  const settingsJson = typeof rawSettingsJson === 'string'
    ? rawSettingsJson
    : JSON.stringify(rawSettingsJson);
  const planExtent = 'document';
  const skipBlockKinds = scope.readerType === 'pdf'
    ? await getDocumentSkipBlockKinds(parsed.documentId, scope.storageUserId)
    : [];
  const isPlainText = scope.readerType === 'html'
    ? scope.documentName.toLowerCase().endsWith('.txt')
    : false;

  return {
    settingsHash,
    settingsJson,
    planning: {
      ...(parsed.maxBlockLength !== undefined ? { maxBlockLength: parsed.maxBlockLength } : {}),
      ...(parsed.language ? { language: parsed.language } : {}),
      ...(scope.readerType !== 'epub' && parsed.startSegmentKey ? { startSegmentKey: parsed.startSegmentKey } : {}),
      ...(scope.readerType !== 'epub' && parsed.startText ? { startText: parsed.startText } : {}),
      enforceSourceBoundaries: scope.readerType === 'pdf' || scope.readerType === 'epub',
      documentSource: {
        namespace: scope.testNamespace,
        skipBlockKinds,
        extent: planExtent,
        ...(scope.readerType === 'pdf' ? { startPage: parsed.startLocation.page ?? 1 } : {}),
        ...(scope.readerType === 'epub' ? { startSpineIndex: parsed.startLocation.spineIndex } : {}),
        ...(scope.readerType === 'epub' && parsed.startLocation.charOffset !== undefined
          ? { startCharOffset: parsed.startLocation.charOffset }
          : {}),
        isPlainText,
      },
    },
  };
}

export function toTtsPlaybackPlanRequest(input: {
  parsed: ParsedTtsPlaybackRequestBody;
  scope: ResolvedSegmentDocumentScope;
  settingsHash: string;
  settingsJson: string;
  planning: TtsPlaybackPlanRequest['planning'];
}): TtsPlaybackPlanRequest {
  return {
    userId: input.scope.userId,
    storageUserId: input.scope.storageUserId,
    documentId: input.parsed.documentId,
    documentVersion: input.scope.documentVersion,
    readerType: input.scope.readerType,
    settingsHash: input.settingsHash,
    settingsJson: input.settingsJson,
    planning: input.planning,
  };
}
