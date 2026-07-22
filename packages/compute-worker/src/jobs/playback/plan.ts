import { normalizeLanguageTag } from '@openreader/tts/language';
import { buildHtmlDocumentText, parseHtmlBlocks } from '@openreader/tts/html-blocks';
import { buildPdfPageSourceUnits } from '@openreader/tts/pdf-sources';
import {
  buildSegmentKeyPrefix,
  normalizeSourceText,
  planCanonicalTtsSegments,
  type CanonicalTtsSourceUnit,
} from '@openreader/tts/segment-plan';
import { computeSegmentationSignature } from '@openreader/tts/segments';
import { isTtsProviderType } from '@openreader/tts/provider-catalog';
import type { TTSSegmentSettings } from '@openreader/tts/types';
import { extractEpubSpine } from '../../inference/epub/spine-text';
import type { ParsedPdfDocument } from '../../operations/contracts';
import {
  documentSourceKey,
  parsedPdfArtifactKey,
  ttsPlaybackPlanArtifactKey,
} from '../../storage/artifact-addressing';
import type { ArtifactStorage } from '../../infrastructure/storage';
import type { TtsPlaybackPlanCapableRequest } from './schemas';

export type TtsPlaybackSegmentInput = {
  ordinal: number;
  segmentKey?: string | null;
  text: string;
  locator: unknown;
};

export function parseTtsSettings(value: unknown): TTSSegmentSettings {
  let raw = value;
  if (typeof raw === 'string') raw = JSON.parse(raw);
  if (!raw || typeof raw !== 'object') {
    throw new Error('TTS playback settingsJson must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const ttsModel = typeof rec.ttsModel === 'string'
    ? rec.ttsModel
    : typeof rec.model === 'string'
      ? rec.model
      : null;
  const nativeSpeed = rec.nativeSpeed ?? rec.speed;
  const ttsInstructions = typeof rec.ttsInstructions === 'string'
    ? rec.ttsInstructions
    : typeof rec.instructions === 'string'
      ? rec.instructions
      : '';
  if (typeof rec.providerRef !== 'string') throw new Error('TTS playback settings missing providerRef');
  if (!isTtsProviderType(rec.providerType)) throw new Error('TTS playback settings missing providerType');
  if (typeof ttsModel !== 'string') throw new Error('TTS playback settings missing ttsModel');
  if (typeof rec.voice !== 'string') throw new Error('TTS playback settings missing voice');
  if (!Number.isFinite(Number(nativeSpeed))) throw new Error('TTS playback settings missing nativeSpeed');
  return {
    providerRef: rec.providerRef,
    providerType: rec.providerType,
    ttsModel,
    voice: rec.voice,
    nativeSpeed: Number(nativeSpeed),
    ttsInstructions,
    language: typeof rec.language === 'string' ? normalizeLanguageTag(rec.language) : 'en',
  };
}

export async function resolvePlaybackSourceUnits(
  request: TtsPlaybackPlanCapableRequest,
  storage: Pick<ArtifactStorage, 'readObject'>,
  s3Prefix: string,
): Promise<CanonicalTtsSourceUnit[]> {
  const documentSource = request.planning.documentSource;
  if (!documentSource) return [];
  if (request.readerType === 'pdf') {
    return derivePdfSourceUnits(request, documentSource, storage, s3Prefix);
  }
  if (request.readerType === 'epub') {
    return deriveEpubSourceUnits(request, documentSource, storage, s3Prefix);
  }
  return deriveHtmlSourceUnits(request, documentSource, storage, s3Prefix);
}

async function deriveHtmlSourceUnits(
  request: TtsPlaybackPlanCapableRequest,
  documentSource: NonNullable<TtsPlaybackPlanCapableRequest['planning']['documentSource']>,
  storage: Pick<ArtifactStorage, 'readObject'>,
  s3Prefix: string,
): Promise<CanonicalTtsSourceUnit[]> {
  const sourceKey = documentSourceKey({
    documentId: request.documentId,
    namespace: documentSource.namespace,
    prefix: s3Prefix,
  });
  const bytes = await storage.readObject(sourceKey);
  const source = Buffer.from(bytes).toString('utf8');
  const text = buildHtmlDocumentText(parseHtmlBlocks(source, Boolean(documentSource.isPlainText)));
  if (!text.trim()) return [];
  return [{
    sourceKey: '1',
    text,
    locator: { readerType: 'html', location: '1' } as CanonicalTtsSourceUnit['locator'],
  }];
}

async function deriveEpubSourceUnits(
  request: TtsPlaybackPlanCapableRequest,
  documentSource: NonNullable<TtsPlaybackPlanCapableRequest['planning']['documentSource']>,
  storage: Pick<ArtifactStorage, 'readObject'>,
  s3Prefix: string,
): Promise<CanonicalTtsSourceUnit[]> {
  const sourceKey = documentSourceKey({
    documentId: request.documentId,
    namespace: documentSource.namespace,
    prefix: s3Prefix,
  });
  const spine = await extractEpubSpine(await storage.readObject(sourceKey));
  if (spine.length === 0) return [];

  const units: CanonicalTtsSourceUnit[] = [];
  for (const item of spine) {
    const chapterText = normalizeSourceText(item.text);
    let searchFrom = 0;
    for (const block of item.blocks) {
      const normalized = normalizeSourceText(block);
      if (!normalized) continue;
      const found = chapterText.indexOf(normalized, searchFrom);
      const chapterOffset = found >= 0 ? found : searchFrom;
      units.push({
        sourceKey: `spine:${item.index}:${item.href}#${chapterOffset}`,
        text: block,
        locator: {
          readerType: 'epub',
          spineHref: item.href,
          spineIndex: item.index,
          charOffset: chapterOffset,
        } as CanonicalTtsSourceUnit['locator'],
      });
      searchFrom = Math.min(chapterText.length, chapterOffset + normalized.length);
    }
  }
  return units;
}

async function derivePdfSourceUnits(
  request: TtsPlaybackPlanCapableRequest,
  documentSource: NonNullable<TtsPlaybackPlanCapableRequest['planning']['documentSource']>,
  storage: Pick<ArtifactStorage, 'readObject'>,
  s3Prefix: string,
): Promise<CanonicalTtsSourceUnit[]> {
  const artifactKey = parsedPdfArtifactKey({
    documentId: request.documentId,
    namespace: documentSource.namespace,
    prefix: s3Prefix,
  });
  const raw = await storage.readObject(artifactKey);
  const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as ParsedPdfDocument;
  const pages = [...(parsed.pages ?? [])].sort((a, b) => a.pageNumber - b.pageNumber);
  const units: CanonicalTtsSourceUnit[] = [];
  for (const page of pages) {
    units.push(...buildPdfPageSourceUnits(page, page.pageNumber, documentSource.skipBlockKinds ?? []));
  }
  return units;
}

function perSegmentLocator(
  ownerLocator: CanonicalTtsSourceUnit['locator'],
  offset: number,
): unknown {
  if (ownerLocator && ownerLocator.readerType === 'epub') {
    const base = Math.max(0, Math.floor(ownerLocator.charOffset ?? 0));
    return { ...ownerLocator, charOffset: base + Math.max(0, Math.floor(offset)) };
  }
  return ownerLocator;
}

export function planTtsPlaybackSegments(
  request: TtsPlaybackPlanCapableRequest,
  sourceUnits: CanonicalTtsSourceUnit[],
): TtsPlaybackSegmentInput[] {
  if (sourceUnits.length === 0) return [];
  const plan = planCanonicalTtsSegments(sourceUnits, {
    readerType: request.readerType,
    maxBlockLength: request.planning.maxBlockLength,
    keyPrefix: buildSegmentKeyPrefix(request.documentId, request.readerType),
    enforceSourceBoundaries: Boolean(request.planning.enforceSourceBoundaries),
    language: request.planning.language || parseTtsSettings(request.settingsJson).language,
  });
  return plan.segments.map((segment, index) => ({
    ordinal: index,
    segmentKey: segment.key,
    text: segment.text,
    locator: perSegmentLocator(segment.ownerLocator, segment.startAnchor.offset),
  }));
}

export function resolvePlaybackStartOrdinal(
  segments: TtsPlaybackSegmentInput[],
  request: TtsPlaybackPlanCapableRequest,
): number {
  if (segments.length === 0) return 0;
  if (request.planning.selectedOrdinal === undefined) {
    throw new Error('TTS playback start requires a worker-plan ordinal');
  }
  const selectedOrdinal = Math.max(0, Math.floor(request.planning.selectedOrdinal));
  const match = segments.find((segment) => segment.ordinal === selectedOrdinal);
  if (!match) {
    throw new Error(`TTS playback start ordinal ${selectedOrdinal} is not present in the canonical plan`);
  }
  return match.ordinal;
}

export function computePlaybackPlanSignature(request: TtsPlaybackPlanCapableRequest): string {
  const documentSource = request.planning.documentSource;
  return computeSegmentationSignature({
    maxBlockLength: request.planning.maxBlockLength ?? null,
    language: request.planning.language ?? parseTtsSettings(request.settingsJson).language ?? null,
    enforceSourceBoundaries: Boolean(request.planning.enforceSourceBoundaries),
    skipBlockKinds: documentSource?.skipBlockKinds ?? [],
    isPlainText: Boolean(documentSource?.isPlainText),
    // Plans contain user-scoped document text and settings metadata. Include
    // the storage owner in their stable identity so identical content owned by
    // different users cannot reuse an operation or artifact across scopes.
    namespace: JSON.stringify([
      documentSource?.namespace ?? null,
      request.storageUserId,
    ]),
  });
}

async function persistTtsPlaybackPlan(input: {
  storage: Pick<ArtifactStorage, 'putObject'>;
  planObjectKey: string;
  request: TtsPlaybackPlanCapableRequest;
  segments: TtsPlaybackSegmentInput[];
}): Promise<string> {
  const artifact = {
    schemaVersion: 1 as const,
    sessionId: input.request.sessionId,
    storageUserId: input.request.storageUserId,
    documentId: input.request.documentId,
    documentVersion: input.request.documentVersion,
    readerType: input.request.readerType,
    settingsHash: input.request.settingsHash,
    settingsJson: input.request.settingsJson,
    segments: input.segments.map((segment) => ({
      ordinal: segment.ordinal,
      segmentKey: segment.segmentKey ?? null,
      text: segment.text,
      locator: segment.locator,
    })),
  };
  await input.storage.putObject(input.planObjectKey, Buffer.from(JSON.stringify(artifact)), 'application/json');
  return input.planObjectKey;
}

export async function readPersistedTtsPlaybackPlanSegments(
  storage: Pick<ArtifactStorage, 'readObject'>,
  planObjectKey: string,
): Promise<TtsPlaybackSegmentInput[] | null> {
  let bytes: ArrayBuffer;
  try {
    bytes = await storage.readObject(planObjectKey);
  } catch {
    return null;
  }
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    schemaVersion?: unknown;
    segments?: Array<{ ordinal?: unknown; segmentKey?: unknown; text?: unknown; locator?: unknown }>;
  };
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported TTS playback plan schema version: ${String(parsed.schemaVersion)}`);
  }
  if (!Array.isArray(parsed.segments)) throw new Error('TTS playback plan artifact missing segments');
  return parsed.segments.map((row) => {
    const ordinal = Number(row.ordinal);
    const text = typeof row.text === 'string' ? row.text : '';
    if (!Number.isFinite(ordinal) || !text) {
      throw new Error('TTS playback plan segment requires ordinal and text');
    }
    return {
      ordinal: Math.max(0, Math.floor(ordinal)),
      segmentKey: typeof row.segmentKey === 'string' ? row.segmentKey : null,
      text,
      locator: row.locator ?? null,
    };
  });
}

export async function resolveAndPersistTtsPlaybackPlan(input: {
  request: TtsPlaybackPlanCapableRequest;
  storage: ArtifactStorage;
  s3Prefix: string;
  requireStartOrdinal?: boolean;
}): Promise<{
  planObjectKey: string;
  planSignature: string;
  plannedSegments: TtsPlaybackSegmentInput[];
  startOrdinal: number;
}> {
  const planSignature = computePlaybackPlanSignature(input.request);
  const computedPlanObjectKey = ttsPlaybackPlanArtifactKey({
    documentId: input.request.documentId,
    documentVersion: input.request.documentVersion,
    readerType: input.request.readerType,
    planSignature,
    prefix: input.s3Prefix,
  });
  const planObjectKey = input.request.planObjectKey ?? computedPlanObjectKey;
  let plannedSegments = await readPersistedTtsPlaybackPlanSegments(input.storage, planObjectKey);
  if (!plannedSegments || plannedSegments.length === 0) {
    plannedSegments = planTtsPlaybackSegments(
      input.request,
      await resolvePlaybackSourceUnits(input.request, input.storage, input.s3Prefix),
    );
    await persistTtsPlaybackPlan({ storage: input.storage, planObjectKey, request: input.request, segments: plannedSegments });
  }
  return {
    planObjectKey,
    planSignature,
    plannedSegments,
    startOrdinal: input.requireStartOrdinal
      ? resolvePlaybackStartOrdinal(plannedSegments, input.request)
      : 0,
  };
}
