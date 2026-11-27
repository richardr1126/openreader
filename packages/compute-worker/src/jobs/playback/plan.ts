import { normalizeLanguageTag } from '@openreader/tts/language';
import { normalizeSpeechText } from '@openreader/tts/speech-text';
import { normalizeVoiceCustomization } from '@openreader/tts/voice-customization';
import { buildHtmlSourceUnits, parseHtmlBlocks } from '@openreader/tts/html-blocks';
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
import type { JobAttempt } from '../../operations/types';
import { prepareArtifactWrite, publishOrAdoptArtifact } from '../../storage/artifact-write';
import {
  documentSourceKey,
  parsedPdfArtifactKey,
  ttsPlaybackPlanArtifactKey,
} from '../../storage/artifact-addressing';
import { isNotFound, type ArtifactStorage } from '../../infrastructure/storage';
import type { TtsPlaybackPlanCapableRequest } from './schemas';
import { PdfLayoutChangedError } from './layout-changed';

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
    ...(typeof rec.ttsModelOptions === 'string' ? { ttsModelOptions: rec.ttsModelOptions } : {}),
    language: typeof rec.language === 'string' ? normalizeLanguageTag(rec.language) : 'en',
    ...(rec.speechText ? { speechText: normalizeSpeechText(rec.speechText) } : {}),
    ...(rec.voiceCustomization ? { voiceCustomization: normalizeVoiceCustomization(rec.voiceCustomization) } : {}),
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
  return buildHtmlSourceUnits(
    parseHtmlBlocks(source, Boolean(documentSource.isPlainText)),
  );
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
  // A plan is keyed by the narration revision it was requested for. Planning a
  // replaced layout under that key would pair its blocks with another layout.
  if ((parsed.narrationRevision ?? null) !== (documentSource.narrationRevision ?? null)) {
    throw new PdfLayoutChangedError();
  }
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
    narrationRevision: documentSource?.narrationRevision ?? null,
  });
}

async function persistTtsPlaybackPlan(input: {
  write: (body: Buffer, contentType: string) => Promise<void>;
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
    ...(input.request.planning.documentSource?.narrationRevision
      ? { narrationRevision: input.request.planning.documentSource.narrationRevision }
      : {}),
    segments: input.segments.map((segment) => ({
      ordinal: segment.ordinal,
      segmentKey: segment.segmentKey ?? null,
      text: segment.text,
      locator: segment.locator,
    })),
  };
  await input.write(Buffer.from(JSON.stringify(artifact)), 'application/json');
  return input.planObjectKey;
}

export async function readPersistedTtsPlaybackPlanSegments(
  storage: Pick<ArtifactStorage, 'readObject'>,
  planObjectKey: string,
  expectedScope?: { documentId: string; documentVersion: number; readerType: string },
  options: {
    /** Only a missing object counts as no plan; other read failures are raised. */
    confirmMissing?: boolean;
    /** The PDF layout revision the request is for; a plan recorded for another is refused. */
    narrationRevision?: string | null;
  } = {},
): Promise<TtsPlaybackSegmentInput[] | null> {
  let bytes: ArrayBuffer;
  try {
    bytes = await storage.readObject(planObjectKey);
  } catch (error) {
    if (options.confirmMissing && !isNotFound(error)) throw error;
    return null;
  }
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    schemaVersion?: unknown;
    documentId?: unknown;
    documentVersion?: unknown;
    readerType?: unknown;
    narrationRevision?: unknown;
    segments?: Array<{ ordinal?: unknown; segmentKey?: unknown; text?: unknown; locator?: unknown }>;
  };
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported TTS playback plan schema version: ${String(parsed.schemaVersion)}`);
  }
  if (expectedScope && (parsed.documentId !== expectedScope.documentId
    || parsed.documentVersion !== expectedScope.documentVersion || parsed.readerType !== expectedScope.readerType)) {
    throw new Error('TTS playback plan scope mismatch');
  }
  if (options.narrationRevision !== undefined
    && (typeof parsed.narrationRevision === 'string' ? parsed.narrationRevision : null) !== options.narrationRevision) {
    // Its text belongs to another layout than the audio this request names.
    throw new Error('The reading plan belongs to another version of this PDF layout. Try again.');
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

/**
 * The PDF layout revision a playback request is for: null for a layout without
 * one, undefined when the request names no PDF layout.
 */
function requestNarrationRevision(request: TtsPlaybackPlanCapableRequest): string | null | undefined {
  const documentSource = request.planning.documentSource;
  return request.readerType === 'pdf' && documentSource ? documentSource.narrationRevision ?? null : undefined;
}

/**
 * Plans a request whose plan was not found under `planObjectKey`.
 *
 * - A PDF layout that a reparse replaced since the request: PDF_LAYOUT_CHANGED.
 * - A saved key on a PDF with a narration revision, which differs from the key
 *   these inputs give: refused, because it may name another revision's text.
 * - Otherwise: planned from the current source, then published under the key.
 *
 * Both refusals first read the plan again, counting only a missing object as
 * gone. A plan found then is returned as stored and is not written again.
 */
async function planMissing(input: {
  request: TtsPlaybackPlanCapableRequest;
  storage: ArtifactStorage;
  s3Prefix: string;
  planObjectKey: string;
  savedKey: boolean;
}): Promise<{ segments: TtsPlaybackSegmentInput[]; stored: boolean }> {
  const narrationRevision = requestNarrationRevision(input.request);
  const refuse = async (error: Error) => {
    const segments = await readPersistedTtsPlaybackPlanSegments(
      input.storage, input.planObjectKey, undefined, { confirmMissing: true, narrationRevision },
    );
    if (segments?.length) return { segments, stored: true };
    throw error;
  };
  let units: CanonicalTtsSourceUnit[];
  try {
    units = await resolvePlaybackSourceUnits(input.request, input.storage, input.s3Prefix);
  } catch (error) {
    if (error instanceof PdfLayoutChangedError) return refuse(error);
    throw error;
  }
  if (input.savedKey && narrationRevision) {
    return refuse(new Error('The reading plan is no longer available. Reopen the document.'));
  }
  return { segments: planTtsPlaybackSegments(input.request, units), stored: false };
}

export async function resolveAndPersistTtsPlaybackPlan(input: {
  request: TtsPlaybackPlanCapableRequest;
  storage: ArtifactStorage;
  s3Prefix: string;
  requireStartOrdinal?: boolean;
  attempt?: JobAttempt;
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
  const write = await prepareArtifactWrite(input.storage, planObjectKey, input.attempt);
  // A plan recorded for another PDF layout revision is never used: its text
  // would be paired with the audio of the revision this request names.
  const narrationRevision = requestNarrationRevision(input.request);
  let plannedSegments = await readPersistedTtsPlaybackPlanSegments(input.storage, planObjectKey, undefined, { narrationRevision });
  if (!plannedSegments || plannedSegments.length === 0) {
    const missing = await planMissing({ ...input, planObjectKey, savedKey: planObjectKey !== computedPlanObjectKey });
    plannedSegments = missing.segments;
    if (!missing.stored) {
      const computed = missing.segments;
      const winner = await publishOrAdoptArtifact(
        () => persistTtsPlaybackPlan({ write, planObjectKey, request: input.request, segments: computed }),
        () => readPersistedTtsPlaybackPlanSegments(input.storage, planObjectKey, input.request, { narrationRevision }),
        input.attempt,
      );
      plannedSegments = winner ?? computed;
    }
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
