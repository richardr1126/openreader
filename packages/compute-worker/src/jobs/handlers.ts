import { z } from 'zod';
import { generateTTSBuffer } from '@openreader/tts/generate';
import { getUpstreamRetryAfterSeconds, getUpstreamStatus } from '@openreader/tts/upstream-response';
import {
  buildTtsSegmentAudioKey,
  buildTtsSegmentEntryId,
  buildTtsSegmentId,
  buildTtsSegmentTextHash,
  computeSegmentationSignature,
  locatorFingerprint,
  normalizeLocator,
  normalizeSegmentText,
  probeAudioDurationMsFromBuffer,
} from '@openreader/tts/segments';
import type { TTSSegmentSettings } from '@openreader/tts/types';
import { resolveEffectiveTtsInstructions } from '@openreader/tts/instructions';
import { isBuiltInTtsProviderId, isTtsProviderType } from '@openreader/tts/provider-catalog';
import { resolveTtsModelForProvider } from '@openreader/tts/provider-policy';
import { normalizeLanguageTag } from '@openreader/tts/language';
import {
  buildSegmentKeyPrefix,
  normalizeSourceText,
  planCanonicalTtsSegments,
  type CanonicalTtsSourceUnit,
} from '@openreader/tts/segment-plan';
import { buildPdfPageSourceUnits } from '@openreader/tts/pdf-sources';
import { buildHtmlDocumentText, parseHtmlBlocks } from '@openreader/tts/html-blocks';
import { documentSourceKey, parsedPdfArtifactKey, ttsPlaybackPlanArtifactKey } from '../storage/artifact-addressing';
import { extractEpubSpine } from '../inference/epub/spine-text';
import type { ParsedPdfDocument } from '../operations/contracts';
import {
  runPdfLayoutFromPdfBuffer,
  runWhisperAlignmentFromAudioBuffer,
} from '../inference/runtime';
import { withIdleTimeoutAndHardCap, withTimeout } from '../infrastructure/config';
import type {
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  PdfLayoutProgress,
  TtsPlaybackJobRequest,
  TtsPlaybackJobResult,
  TtsPlaybackPlanJobRequest,
  TtsPlaybackPlanJobResult,
  TtsPlaybackProgress,
} from '../operations/contracts';
import type { ArtifactStorage } from '../infrastructure/storage';
import type { TtsPlaybackStorage } from '../playback/storage';
import { generationFloorForCursor } from '../playback/generation-window';
import { persistParsedPdfWhileSourceExists } from './pdf-artifact-persistence';
import { buildInferProgressForPageParsed, buildInferProgressForPageStart } from './pdf-progress';
import { resolveTtsCredentials } from './tts-credentials';

const pdfRequestSchema = z.object({
  documentId: z.string().trim().min(1),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentObjectKey: z.string().trim().min(1).max(2048),
});

const ttsPlaybackRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  documentId: z.string().trim().min(1),
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  settingsJson: z.unknown(),
  planObjectKey: z.string().trim().min(1).max(2048).optional(),
  generationRunId: z.string().trim().min(1).max(128).optional(),
  expiresAt: z.number().int().positive().optional(),
  aheadWindow: z.number().int().positive().max(4096).optional(),
  backgroundExtent: z.enum(['section', 'document']).optional(),
  planning: z.object({
    selectedOrdinal: z.number().int().nonnegative().optional(),
    maxBlockLength: z.number().int().positive().max(20_000).optional(),
    enforceSourceBoundaries: z.boolean().optional(),
    language: z.string().trim().min(1).max(32).optional(),
    documentSource: z.object({
      namespace: z.string().trim().min(1).max(128).nullable(),
      skipBlockKinds: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
      extent: z.enum(['section', 'document']),
      isPlainText: z.boolean().optional(),
    }).optional(),
  }),
});

const ttsPlaybackPlanRequestSchema = ttsPlaybackRequestSchema
  .omit({ sessionId: true, planObjectKey: true, generationRunId: true, expiresAt: true, aheadWindow: true, backgroundExtent: true })
  .extend({});

// Sliding-window pacing constants for bounded forward-generation runs.
const TTS_PLAYBACK_DEFAULT_AHEAD_WINDOW = 8;
// How long after the client's last cursor write we still treat it as connected.
// Past this the client is assumed disconnected (JS suspended / tab closed) and
// generation switches to "background" mode bounded by `backgroundExtent`.
const TTS_PLAYBACK_CURSOR_STALE_MS = 15_000;

class TtsPlaybackSegmentTimeoutError extends Error {
  readonly code = 'UPSTREAM_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`TTS playback segment synthesis timed out after ${timeoutMs}ms`);
    this.name = 'TtsPlaybackSegmentTimeoutError';
  }
}

/**
 * The "section" a plan segment belongs to, used to bound background generation
 * when `backgroundExtent === 'section'`: a PDF page or an EPUB spine entry.
 * HTML has no sections, so it returns null (the whole document is one section).
 */
function playbackSectionKey(locator: unknown, readerType: 'pdf' | 'epub' | 'html'): string | null {
  if (!locator || typeof locator !== 'object') return null;
  const rec = locator as Record<string, unknown>;
  if (readerType === 'pdf' && Number.isFinite(Number(rec.page))) return `p${Math.floor(Number(rec.page))}`;
  if (readerType === 'epub' && Number.isFinite(Number(rec.spineIndex))) return `s${Math.floor(Number(rec.spineIndex))}`;
  return null;
}

function textHmacSecret(): string {
  return process.env.AUTH_SECRET?.trim()
    || 'openreader-default-tts-segment-secret';
}

export function parseTtsSettings(value: unknown): TTSSegmentSettings {
  let raw = value;
  if (typeof raw === 'string') {
    raw = JSON.parse(raw);
  }
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

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function withAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const operation = run(controller.signal);
  try {
    return await withTimeout(operation, timeoutMs, label);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} timed out after ${timeoutMs}ms`) {
      controller.abort();
      throw new TtsPlaybackSegmentTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    controller.abort();
  }
}

type TtsPlaybackSegmentInput = {
  segmentIndex: number;
  segmentKey?: string | null;
  text: string;
  locator: unknown;
};

/**
 * Resolve the canonical source units for a playback job from the persisted
 * document artifact. This keeps planning/generation worker-owned so playback can
 * continue independently of the client.
 */
export async function resolvePlaybackSourceUnits(
  request: z.infer<typeof ttsPlaybackRequestSchema>,
  storage: Pick<ArtifactStorage, 'readObject'>,
  s3Prefix: string,
): Promise<CanonicalTtsSourceUnit[]> {
  const planning = request.planning;
  const documentSource = planning.documentSource;
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
  request: z.infer<typeof ttsPlaybackRequestSchema>,
  documentSource: NonNullable<z.infer<typeof ttsPlaybackRequestSchema>['planning']['documentSource']>,
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
  const blocks = parseHtmlBlocks(source, Boolean(documentSource.isPlainText));
  const text = buildHtmlDocumentText(blocks);
  if (!text.trim()) return [];

  // The HTML reader treats the whole document as one flat page (location '1'),
  // so the worker emits a single full-document source unit matching the client.
  return [{
    sourceKey: '1',
    text,
    locator: { readerType: 'html', location: '1' } as CanonicalTtsSourceUnit['locator'],
  }];
}

async function deriveEpubSourceUnits(
  request: z.infer<typeof ttsPlaybackRequestSchema>,
  documentSource: NonNullable<z.infer<typeof ttsPlaybackRequestSchema>['planning']['documentSource']>,
  storage: Pick<ArtifactStorage, 'readObject'>,
  s3Prefix: string,
): Promise<CanonicalTtsSourceUnit[]> {
  const sourceKey = documentSourceKey({
    documentId: request.documentId,
    namespace: documentSource.namespace,
    prefix: s3Prefix,
  });
  const bytes = await storage.readObject(sourceKey);
  const spine = await extractEpubSpine(bytes);
  if (spine.length === 0) return [];

  // Position-independent plan: derive the whole book (all spine items from index
  // 0) regardless of the session's start position. The start position is resolved
  // separately into an absolute `startOrdinal`; the background extent setting (not
  // plan scope) controls how far generation runs on disconnect.
  //
  // One source unit per BLOCK (paragraph/heading/…), not per whole chapter, so the
  // segmenter runs with `enforceSourceBoundaries` over small bounded units —
  // mirroring how PDF derives one unit per layout block. This avoids joining the
  // whole book into one canonical string and the O(n²) remapping that froze the
  // worker. Each unit carries its block's char offset within the chapter's
  // normalized text so per-segment `charOffset`s stay chapter-relative (a stable
  // hint the client uses when re-anchoring highlights against the spine text).
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
  request: z.infer<typeof ttsPlaybackRequestSchema>,
  documentSource: NonNullable<z.infer<typeof ttsPlaybackRequestSchema>['planning']['documentSource']>,
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
  if (pages.length === 0) return [];

  // Position-independent plan: derive the whole document (all pages) regardless
  // of the session start page. Start position becomes an absolute `startOrdinal`;
  // background extent controls generation reach, not plan scope.
  const skipKinds = documentSource.skipBlockKinds ?? [];
  const units: CanonicalTtsSourceUnit[] = [];
  for (const page of pages) {
    units.push(...buildPdfPageSourceUnits(page, page.pageNumber, skipKinds));
  }
  return units;
}

/**
 * Stamp a segment's owner locator with its own per-segment offset. For EPUB the
 * canonical plan's `startAnchor.offset` IS the normalized-text charOffset the
 * client uses for the locator identity / highlighting, so we copy it here
 * (the chapter source unit carries charOffset 0 for every segment otherwise).
 */
function perSegmentLocator(
  ownerLocator: CanonicalTtsSourceUnit['locator'],
  offset: number,
): unknown {
  if (ownerLocator && ownerLocator.readerType === 'epub') {
    // `ownerLocator.charOffset` is the block's base offset within the chapter;
    // `offset` is the segment's offset within that block. Sum keeps the stamped
    // charOffset chapter-relative (matching the single whole-chapter unit the
    // client anchors against).
    const base = Math.max(0, Math.floor(ownerLocator.charOffset ?? 0));
    return { ...ownerLocator, charOffset: base + Math.max(0, Math.floor(offset)) };
  }
  return ownerLocator;
}

/**
 * Build the whole-document (whole-book for EPUB) canonical plan with **absolute**
 * ordinals. The plan is position-independent: it does not slice or re-index from
 * the start position, so the same sentence always carries the same ordinal/key no
 * matter where playback begins. The start position is resolved separately into an
 * absolute `startOrdinal` (see {@link resolvePlaybackStartOrdinal}).
 */
export function planTtsPlaybackSegments(
  request: z.infer<typeof ttsPlaybackRequestSchema>,
  sourceUnits: CanonicalTtsSourceUnit[],
): TtsPlaybackSegmentInput[] {
  const planning = request.planning;
  if (sourceUnits.length === 0) return [];

  const plan = planCanonicalTtsSegments(sourceUnits, {
    readerType: request.readerType,
    maxBlockLength: planning.maxBlockLength,
    keyPrefix: buildSegmentKeyPrefix(request.documentId, request.readerType),
    enforceSourceBoundaries: Boolean(planning.enforceSourceBoundaries),
    language: planning.language || parseTtsSettings(request.settingsJson).language,
  });

  return plan.segments.map((segment, index) => ({
    segmentIndex: index,
    segmentKey: segment.key,
    text: segment.text,
    locator: perSegmentLocator(segment.ownerLocator, segment.startAnchor.offset),
  }));
}

/**
 * Resolve the absolute canonical ordinal where playback should begin. Audio
 * start is ordinal-only: reader locators/text can drive UI navigation and
 * highlighting, but they are not fallback playback identities.
 */
export function resolvePlaybackStartOrdinal(
  segments: TtsPlaybackSegmentInput[],
  request: z.infer<typeof ttsPlaybackRequestSchema>,
): number {
  if (segments.length === 0) return 0;
  const planning = request.planning;
  if (planning.selectedOrdinal === undefined) {
    throw new Error('TTS playback start requires a worker-plan ordinal');
  }
  const selectedOrdinal = Math.max(0, Math.floor(planning.selectedOrdinal));
  const match = segments.find((segment) => segment.segmentIndex === selectedOrdinal);
  if (!match) {
    throw new Error(`TTS playback start ordinal ${selectedOrdinal} is not present in the canonical plan`);
  }
  return match.segmentIndex;
}

/**
 * Deterministic hash of the segmentation knobs that affect plan shape (but NOT
 * voice/speed, which only affect audio). Two sessions over the same document
 * version + reader type with the same knobs share one cached canonical plan.
 */
export function computePlaybackPlanSignature(
  request: z.infer<typeof ttsPlaybackRequestSchema>,
): string {
  const planning = request.planning;
  const documentSource = planning.documentSource;
  return computeSegmentationSignature({
    maxBlockLength: planning.maxBlockLength ?? null,
    language: planning.language ?? parseTtsSettings(request.settingsJson).language ?? null,
    enforceSourceBoundaries: Boolean(planning.enforceSourceBoundaries),
    skipBlockKinds: documentSource?.skipBlockKinds ?? [],
    isPlainText: Boolean(documentSource?.isPlainText),
    namespace: documentSource?.namespace ?? null,
  });
}

/**
 * Persist the reusable canonical plan for a playback session to object storage
 * and return its key. SQL stores only the key; this artifact is the full,
 * ordered segment plan (keys, text, locators) the worker generated against.
 */
async function persistTtsPlaybackPlan(input: {
  storage: Pick<ArtifactStorage, 'putObject'>;
  planObjectKey: string;
  request: z.infer<typeof ttsPlaybackRequestSchema>;
  segments: TtsPlaybackSegmentInput[];
}): Promise<string> {
  const key = input.planObjectKey;
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
      segmentIndex: segment.segmentIndex,
      segmentKey: segment.segmentKey ?? null,
      text: segment.text,
      locator: segment.locator,
    })),
  };
  await input.storage.putObject(key, Buffer.from(JSON.stringify(artifact)), 'application/json');
  return key;
}

/**
 * Read back the persisted plan for a session as generation inputs. Sliding-
 * window jobs after the first reuse this instead of re-deriving source units
 * and re-segmenting (which would re-parse the whole document each window).
 * Returns null when no plan has been persisted yet (the first job).
 */
async function readPersistedTtsPlaybackPlanSegments(
  storage: Pick<ArtifactStorage, 'readObject'>,
  planObjectKey: string,
): Promise<TtsPlaybackSegmentInput[] | null> {
  try {
    const bytes = await storage.readObject(planObjectKey);
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
      segments?: Array<{ segmentIndex?: unknown; segmentKey?: unknown; text?: unknown; locator?: unknown }>;
    };
    if (!Array.isArray(parsed.segments)) return null;
    return parsed.segments
      .map((row): TtsPlaybackSegmentInput | null => {
        const segmentIndex = Number(row.segmentIndex);
        const text = typeof row.text === 'string' ? row.text : '';
        if (!Number.isFinite(segmentIndex) || !text) return null;
        return {
          segmentIndex: Math.max(0, Math.floor(segmentIndex)),
          segmentKey: typeof row.segmentKey === 'string' ? row.segmentKey : null,
          text,
          locator: row.locator ?? null,
        };
      })
      .filter((row): row is TtsPlaybackSegmentInput => Boolean(row));
  } catch {
    return null;
  }
}

async function resolveAndPersistTtsPlaybackPlan(input: {
  request: z.infer<typeof ttsPlaybackRequestSchema>;
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
    const sourceUnits = await resolvePlaybackSourceUnits(input.request, input.storage, input.s3Prefix);
    plannedSegments = planTtsPlaybackSegments(input.request, sourceUnits);
    await persistTtsPlaybackPlan({
      storage: input.storage,
      planObjectKey,
      request: input.request,
      segments: plannedSegments,
    });
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

const SEGMENT_MAX_ATTEMPTS = 2;

type SegmentErrorInfo = {
  message: string;
  code?: 'UPSTREAM_RATE_LIMIT' | 'UPSTREAM_ERROR' | 'UPSTREAM_TIMEOUT';
  upstreamStatus?: number;
  retryAfterSeconds?: number;
};

/**
 * Classify a synthesis failure so the stored `error` preserves provider context
 * (HTTP status, Retry-After) instead of an opaque message, and so the retry loop
 * can stop early on non-retryable client errors. Retryable: provider 429 and 5xx
 * (and unknown/transport errors). Non-retryable: other 4xx (bad request / auth).
 */
function classifySegmentError(error: unknown): { info: SegmentErrorInfo; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TtsPlaybackSegmentTimeoutError) {
    return { info: { message, code: error.code }, retryable: false };
  }
  const upstreamStatus = getUpstreamStatus(error);
  if (upstreamStatus === undefined) {
    return { info: { message }, retryable: true };
  }
  if (upstreamStatus === 429) {
    const retryAfterSeconds = getUpstreamRetryAfterSeconds(error);
    return {
      info: { message, code: 'UPSTREAM_RATE_LIMIT', upstreamStatus, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
      retryable: true,
    };
  }
  if (upstreamStatus >= 500) {
    return { info: { message, code: 'UPSTREAM_ERROR', upstreamStatus }, retryable: true };
  }
  // Other 4xx (bad request, auth, unsupported voice): retrying won't help.
  return { info: { message, code: 'UPSTREAM_ERROR', upstreamStatus }, retryable: false };
}

async function generateExplicitTtsPlaybackSegments(input: {
  request: z.infer<typeof ttsPlaybackRequestSchema>;
  s3Prefix: string;
  segments: TtsPlaybackSegmentInput[];
  putAudioObject: (key: string, body: Buffer) => Promise<void>;
  /** Content-addressed existence check: the source of truth for "already generated". */
  audioObjectExists: (key: string) => Promise<boolean>;
  playbackStorage?: TtsPlaybackStorage;
  /** Read previously-stored segment audio back (for the alignment self-heal path). */
  readAudioObject?: (key: string) => Promise<Buffer>;
  synthesisTimeoutMs: number;
  /**
   * Pacing gate, called before each segment with its plan ordinal. Returns
   * 'continue' to generate it, 'stop' to end generation gracefully (the client
   * has fallen far enough behind / a background extent boundary is reached).
   */
  onBeforeSegment?: (planOrdinal: number) => Promise<'continue' | 'stop'>;
  /** Called after a segment's audio is ready (or already was), with its plan ordinal. */
  onSegmentCompleted?: (planOrdinal: number) => Promise<void>;
  /** Called after a segment is recorded as an error, with its plan ordinal. */
  onSegmentErrored?: (planOrdinal: number) => Promise<void>;
}): Promise<void> {
  const segments = input.segments;
  if (segments.length === 0) return;

  const settings = parseTtsSettings(input.request.settingsJson);
  const requestCreds = await resolveTtsCredentials({
    providerHeader: settings.providerRef,
  });
  if ('error' in requestCreds) {
    throw new Error(`Unable to resolve TTS provider credentials: ${requestCreds.error}`);
  }

  const effectiveProviderRef = requestCreds.adminRecord?.slug || settings.providerRef;
  const resolvedProviderType = isBuiltInTtsProviderId(requestCreds.provider)
    ? requestCreds.provider
    : 'unknown';
  const effectiveModel = resolveTtsModelForProvider({
    providerRef: effectiveProviderRef,
    providerType: resolvedProviderType,
    model: settings.ttsModel,
    sharedProviders: requestCreds.adminRecord ? [requestCreds.adminRecord] : [],
    fallbackProviderRef: '',
    showAllProviderModels: true,
  });
  const effectiveInstructions = resolveEffectiveTtsInstructions({
    model: effectiveModel,
    requestInstructions: settings.ttsInstructions,
    sharedDefaultInstructions: requestCreds.adminRecord?.defaultInstructions,
  }) ?? '';
  const effectiveSettings: TTSSegmentSettings = {
    ...settings,
    providerRef: effectiveProviderRef,
    providerType: resolvedProviderType,
    ttsModel: effectiveModel,
    ttsInstructions: effectiveInstructions,
  };

  const secret = textHmacSecret();
  const normalized = segments.map((segment) => {
    const text = normalizeSegmentText(segment.text);
    const locator = normalizeLocator(segment.locator as never);
    if (!text || !locator) return null;
    const locatorHash = locatorFingerprint(locator);
    const segmentKey = typeof segment.segmentKey === 'string' && segment.segmentKey.trim()
      ? segment.segmentKey.trim()
      : null;
    const textHash = buildTtsSegmentTextHash(text, secret);
    const segmentEntryId = buildTtsSegmentEntryId({
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      segmentIndex: segment.segmentIndex,
      segmentKey,
      locatorIdentityKey: locatorHash,
      textHash,
    });
    const segmentId = buildTtsSegmentId({
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      settingsHash: input.request.settingsHash,
      segmentIndex: segment.segmentIndex,
      segmentKey,
      normalizedText: text,
      locatorFingerprint: locatorHash,
    });
    return {
      original: segment,
      text,
      segmentEntryId,
      segmentId,
      segmentKey,
      textHash,
    };
  }).filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));

  if (normalized.length === 0) return;

  if (!input.playbackStorage) {
    throw new Error('TTS playback storage is required for segment generation');
  }

  // Read one segment's durable sidecar (duration + alignment + status) by ordinal.
  // Replaces the old aggregate index lookup; each sidecar is its own object.
  const readSidecar = (segment: (typeof normalized)[number]) =>
    input.playbackStorage!.artifacts.readSegmentMetadata({
      storageUserId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      settingsHash: input.request.settingsHash,
      segmentIndex: segment.original.segmentIndex,
    });

  // Word-level alignment from an audio buffer. Shared by the generation path and
  // the completed-but-unaligned self-heal path; returns null on any failure so a
  // missing alignment degrades to sentence-level highlighting rather than failing.
  const computeAlignment = async (
    audio: Buffer,
    segment: (typeof normalized)[number],
    audioKey: string,
  ) => {
    return runWhisperAlignmentFromAudioBuffer({
      audioBuffer: bufferToArrayBuffer(audio),
      text: segment.text,
      lang: effectiveSettings.language,
      cacheKey: `${segment.segmentId}:${audioKey}`,
    }).then((result) => {
      const first = result.alignments[0];
      return first ? { ...first, sentenceIndex: segment.original.segmentIndex } : null;
    }).catch(() => null);
  };

  const persistSegmentMetadata = async (
    segment: (typeof normalized)[number],
    status: 'generating' | 'completed' | 'error',
    metadata: {
      audioKey: string;
      durationMs?: number | null;
      alignment?: Awaited<ReturnType<typeof computeAlignment>> | null;
      error?: unknown | null;
      updatedAt?: number;
    },
  ): Promise<void> => {
    if (!input.playbackStorage) return;
    const updatedAt = metadata.updatedAt ?? Date.now();
    await input.playbackStorage.artifacts.putSegmentMetadata({
      schemaVersion: 1,
      status,
      storageUserId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      readerType: input.request.readerType,
      settingsHash: input.request.settingsHash,
      settingsJson: input.request.settingsJson,
      segmentId: segment.segmentId,
      segmentEntryId: segment.segmentEntryId,
      segmentIndex: segment.original.segmentIndex,
      segmentKey: segment.segmentKey,
      textHash: segment.textHash,
      textLength: segment.text.length,
      audioKey: metadata.audioKey,
      audioFormat: 'mp3',
      durationMs: metadata.durationMs ?? null,
      alignment: metadata.alignment ?? null,
      error: metadata.error ?? null,
      updatedAt,
    });
  };

  for (const segment of normalized) {
    // The pacing gate is the single stop/cancel point: it reads session status +
    // cursor and returns 'stop' when the session was superseded/expired (so a
    // canceled session ends gracefully here rather than throwing → 'failed').
    const planOrdinal = segment.original.segmentIndex;
    if (input.onBeforeSegment) {
      const decision = await input.onBeforeSegment(planOrdinal);
      if (decision === 'stop') break;
    }

    // The segment audio is content-addressed: the same text+voice+model+settings
    // always hashes to the same key. So the key is deterministic (no need to read
    // a prior record to learn it) and its presence in object storage is the
    // single source of truth for "already generated" — no claims, no locks. Two
    // workers racing on the same segment just write identical bytes to the same
    // key (wasteful at worst, never incorrect).
    const audioKey = buildTtsSegmentAudioKey({
      storagePrefix: input.s3Prefix,
      namespace: null,
      userId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      settingsHash: input.request.settingsHash,
      segmentId: segment.segmentId,
    });

    const existing = await readSidecar(segment).catch(() => null);
    const audioExists = await input.audioObjectExists(audioKey).catch(() => false);

    if (audioExists) {
      // Audio is durable. Ensure the sidecar exists and carries duration +
      // alignment; rebuild/self-heal it from the stored audio when missing (a
      // cleared sidecar, a cross-worker write, or a prior transient Whisper
      // failure) — all without re-synthesizing. Content-addressed audio wins
      // over a stale `error` sidecar.
      let durationMs = existing?.status === 'completed' ? existing.durationMs : null;
      let alignment = existing?.alignment ?? null;
      const needsRebuild = existing?.status !== 'completed' || durationMs == null || !alignment;
      if (needsRebuild && input.readAudioObject) {
        try {
          const storedAudio = await input.readAudioObject(audioKey);
          if (durationMs == null) {
            durationMs = await probeAudioDurationMsFromBuffer(storedAudio).catch(() => 0);
          }
          if (!alignment) {
            alignment = await computeAlignment(storedAudio, segment, audioKey);
          }
        } catch {
          // Leave what we have; a future generation pass retries the self-heal.
        }
      }
      if (needsRebuild) {
        await persistSegmentMetadata(segment, 'completed', {
          audioKey,
          durationMs: Math.max(1, Number(durationMs ?? 1000)),
          alignment,
          updatedAt: Date.now(),
        }).catch(() => undefined);
      }
      await input.onSegmentCompleted?.(planOrdinal);
      continue;
    }

    if (existing?.status === 'error') {
      // Recorded terminal error and no durable audio: leave the gap (playback
      // halts cleanly here) rather than hammering a failing provider every pass.
      await input.onSegmentErrored?.(planOrdinal);
      continue;
    }

    let lastError: unknown = null;
    let lastErrorInfo: SegmentErrorInfo | null = null;
    let completed = false;
    for (let attempt = 1; attempt <= SEGMENT_MAX_ATTEMPTS; attempt += 1) {
      try {
        const audioBuffer = await withAbortableTimeout(
          (signal) => generateTTSBuffer({
            text: segment.text,
            voice: effectiveSettings.voice,
            speed: effectiveSettings.nativeSpeed,
            format: 'mp3',
            model: effectiveSettings.ttsModel,
            instructions: effectiveSettings.ttsInstructions,
            language: effectiveSettings.language,
            provider: requestCreds.provider,
            apiKey: requestCreds.apiKey,
            baseUrl: requestCreds.baseUrl,
          }, signal, { ttsUpstreamTimeoutMs: input.synthesisTimeoutMs }),
          input.synthesisTimeoutMs,
          'tts playback segment synthesis',
        );
        await input.putAudioObject(audioKey, audioBuffer);
        const durationMs = await probeAudioDurationMsFromBuffer(audioBuffer).catch(() => 0);
        const alignment = await computeAlignment(audioBuffer, segment, audioKey);

        await persistSegmentMetadata(segment, 'completed', {
          audioKey,
          durationMs,
          alignment,
          updatedAt: Date.now(),
        }).catch(() => undefined);
        completed = true;
        break;
      } catch (error) {
        lastError = error;
        const classified = classifySegmentError(error);
        lastErrorInfo = classified.info;
        // Don't waste a second synthesis on a non-retryable client error
        // (bad request / auth / unsupported voice).
        if (!classified.retryable) break;
      }
    }

    if (completed) {
      await input.onSegmentCompleted?.(planOrdinal);
      continue;
    }

    // A single segment failing must not nuke the session: mark it `error` and
    // move on. The playback timeline stops at the first gap (contiguous
    // prefix), so already-generated audio keeps playing; a persistent gap just
    // halts playback cleanly at this segment instead of failing the whole job.
    // The error is stored structured (code/upstreamStatus/retryAfterSeconds) so a
    // provider 429/5xx is distinguishable from an opaque failure.
    await persistSegmentMetadata(segment, 'error', {
      audioKey,
      error: lastErrorInfo ?? {
        message: lastError instanceof Error ? lastError.message : String(lastError),
      },
      updatedAt: Date.now(),
    }).catch(() => undefined);
    await input.onSegmentErrored?.(planOrdinal);
  }
}

export interface JobHandlers {
  runPdfLayout(
    payload: PdfLayoutJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: PdfLayoutProgress) => Promise<void> },
  ): Promise<PdfLayoutJobResult>;
  runTtsPlayback(
    payload: TtsPlaybackJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: TtsPlaybackProgress) => Promise<void> },
  ): Promise<TtsPlaybackJobResult>;
  runTtsPlaybackPlan(
    payload: TtsPlaybackPlanJobRequest,
    queueWaitMs: number,
  ): Promise<TtsPlaybackPlanJobResult>;
}

export function createJobHandlers(input: {
  storage: ArtifactStorage;
  playbackStorage?: TtsPlaybackStorage;
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  pdfHardCapMs: number;
  ttsPlaybackSegmentTimeoutMs: number;
  s3Prefix: string;
}): JobHandlers {
  return {
    async runPdfLayout(payload, queueWaitMs, hooks) {
      const parsed = pdfRequestSchema.parse(payload);
      const s3FetchStartedAt = Date.now();
      const pdfBytes = await withTimeout(
        input.storage.readObject(parsed.documentObjectKey),
        Math.max(input.pdfTimeoutMs, 1_000),
        'pdf s3 fetch',
      );
      const s3FetchMs = Date.now() - s3FetchStartedAt;
      let lastTotalPages = 0;
      let lastPagesParsed = 0;
      const computeStartedAt = Date.now();
      const result = await withIdleTimeoutAndHardCap({
        idleTimeoutMs: Math.max(input.pdfTimeoutMs, 1_000),
        hardCapMs: input.pdfHardCapMs,
        label: 'pdf layout job',
        run: async (touchProgress) => runPdfLayoutFromPdfBuffer({
          documentId: parsed.documentId,
          pdfBytes,
          onPageStarted: async ({ pageNumber, totalPages }) => {
            touchProgress();
            lastTotalPages = totalPages;
            await hooks?.onProgress?.(buildInferProgressForPageStart({ pageNumber, totalPages }));
          },
          onPageParsed: async ({ pageNumber, totalPages }) => {
            touchProgress();
            lastTotalPages = totalPages;
            lastPagesParsed = pageNumber;
            await hooks?.onProgress?.(buildInferProgressForPageParsed({ pageNumber, totalPages }));
          },
        }),
      });
      const computeMs = Date.now() - computeStartedAt;
      if (hooks?.onProgress && lastTotalPages > 0) {
        await hooks.onProgress({
          totalPages: lastTotalPages,
          pagesParsed: lastPagesParsed,
          currentPage: lastPagesParsed || undefined,
          phase: 'merge',
        });
      }
      const parsedObjectKey = await persistParsedPdfWhileSourceExists({
        sourceObjectKey: parsed.documentObjectKey,
        sourceExists: input.storage.objectExists,
        putParsedObject: () => input.storage.putParsedPdf(parsed.documentId, parsed.namespace, result.parsed),
        deleteParsedObject: input.storage.deleteObject,
      });
      return {
        parsedObjectKey,
        timing: { queueWaitMs, s3FetchMs, computeMs },
      };
    },

    async runTtsPlayback(payload, queueWaitMs, hooks) {
      const parsed = ttsPlaybackRequestSchema.parse(payload);
      const startedAt = Date.now();
      if (!input.playbackStorage) {
        throw new Error('TTS playback storage is required');
      }
      const playbackStorage = input.playbackStorage;
      const kvSession = await playbackStorage.sessions.getSession(parsed.sessionId);
      if (!kvSession) throw new Error('TTS playback session no longer exists');
      if (kvSession.status !== 'queued' && kvSession.status !== 'running') {
        throw new Error(kvSession.lastError || `TTS playback session is ${kvSession.status}`);
      }
      try {
        const plan = await resolveAndPersistTtsPlaybackPlan({
          request: parsed,
          storage: input.storage,
          s3Prefix: input.s3Prefix,
          requireStartOrdinal: true,
        });
        const { planObjectKey, plannedSegments, startOrdinal } = plan;
        const isContinuationRun = Boolean(parsed.generationRunId);
        const sessionCursorOrdinal = Math.max(0, Math.floor(Number(kvSession.cursorOrdinal ?? startOrdinal)));
        const sessionCursorUpdatedAt = kvSession.cursorUpdatedAt == null ? null : Number(kvSession.cursorUpdatedAt);

        await playbackStorage.sessions.patchSession(parsed.sessionId, {
          status: 'running',
          planObjectKey,
          generationStartOrdinal: isContinuationRun
            ? Math.max(0, Math.floor(Number(kvSession.generationStartOrdinal ?? startOrdinal)))
            : startOrdinal,
          cursorOrdinal: isContinuationRun ? sessionCursorOrdinal : startOrdinal,
          cursorUpdatedAt: isContinuationRun ? sessionCursorUpdatedAt : Date.now(),
          lastError: null,
        });
        const lastOrdinal = plannedSegments.reduce((max, s) => Math.max(max, s.segmentIndex), -1);
        const plannedCount = plannedSegments.length;
        const aheadWindow = parsed.aheadWindow ?? TTS_PLAYBACK_DEFAULT_AHEAD_WINDOW;
        const backgroundExtent = parsed.backgroundExtent ?? 'section';

        // Section map (for background-extent bounding) + ordered ordinals.
        const sectionByOrdinal = new Map<number, string | null>();
        for (const segment of plannedSegments) {
          sectionByOrdinal.set(segment.segmentIndex, playbackSectionKey(segment.locator, parsed.readerType));
        }
        const orderedOrdinals = plannedSegments.map((s) => s.segmentIndex).sort((a, b) => a - b);
        const backgroundTargetFor = (cursorOrdinal: number): number => {
          if (backgroundExtent === 'document') return lastOrdinal;
          const section = sectionByOrdinal.get(cursorOrdinal) ?? null;
          if (section == null) return lastOrdinal; // HTML / unknown ⇒ whole document
          let target = cursorOrdinal;
          for (const ord of orderedOrdinals) {
            if (ord >= cursorOrdinal && (sectionByOrdinal.get(ord) ?? null) === section) target = ord;
          }
          return target;
        };

        // Bound each worker run to the currently allowed generation window.
        // When caught up to a fresh cursor, or past the stale-cursor background
        // target, the job exits successfully instead of idling in the worker slot.
        let stoppedEarly = false;
        let lastCompletedThrough = -1;

        const onBeforeSegment = async (planOrdinal: number): Promise<'continue' | 'stop'> => {
          const kvCursor = await playbackStorage.sessions.getSession(parsed.sessionId).catch(() => null);
          const cursor = kvCursor
            ? {
              status: kvCursor.status,
              cursorOrdinal: Math.max(0, Math.floor(Number(kvCursor.cursorOrdinal ?? 0))),
              cursorUpdatedAt: kvCursor.cursorUpdatedAt == null ? null : Number(kvCursor.cursorUpdatedAt),
              expiresAt: Number(kvCursor.expiresAt),
            }
            : null;
          if (!cursor || (cursor.status !== 'queued' && cursor.status !== 'running')) {
            stoppedEarly = true;
            return 'stop';
          }
          const now = Date.now();
          if (now > cursor.expiresAt) {
            stoppedEarly = true;
            return 'stop';
          }
          // Abandon a run that has fallen BELOW the current generation floor: the
          // cursor moved ahead (a forward seek, or playback outran us), so the
          // ordinals between here and the cursor are skipped. Stopping lets a
          // continuation re-anchor AT the floor instead of grinding through the
          // gap in order. During steady playback the frontier is ahead of the
          // cursor, so this never fires.
          if (planOrdinal < generationFloorForCursor(cursor.cursorOrdinal)) {
            stoppedEarly = true;
            return 'stop';
          }
          const fresh = cursor.cursorUpdatedAt != null
            && (now - cursor.cursorUpdatedAt) <= TTS_PLAYBACK_CURSOR_STALE_MS;
          if (fresh) {
            if (planOrdinal <= cursor.cursorOrdinal + aheadWindow) return 'continue';
            stoppedEarly = true;
            return 'stop';
          }
          if (planOrdinal <= backgroundTargetFor(cursor.cursorOrdinal)) {
            return 'continue';
          }
          stoppedEarly = true;
          return 'stop';
        };

        const onSegmentCompleted = async (planOrdinal: number): Promise<void> => {
          if (planOrdinal > lastCompletedThrough) lastCompletedThrough = planOrdinal;
          await hooks?.onProgress?.({ completedThroughOrdinal: lastCompletedThrough, plannedCount });
        };

        // Generate forward from the generation floor. The floor follows the cursor:
        // a fresh run centers on the resolved start; a continuation run centers on
        // wherever the cursor has since moved (a forward seek re-centers ahead; a
        // backward seek — even below the original start — re-centers behind so we
        // produce REAL audio there rather than silence). Earlier ordinals below the
        // floor are scaffolding silence in the stream, and the section/background
        // maps above still use the full plan so extent boundaries resolve correctly.
        const generationFloor = generationFloorForCursor(
          isContinuationRun ? sessionCursorOrdinal : startOrdinal,
        );
        const generationSegments = plannedSegments.filter((segment) => segment.segmentIndex >= generationFloor);

        await generateExplicitTtsPlaybackSegments({
          request: parsed,
          s3Prefix: input.s3Prefix,
          segments: generationSegments,
          putAudioObject: (key, body) => input.storage.putObject(key, body, 'audio/mpeg'),
          audioObjectExists: (key) => input.storage.objectExists(key),
          playbackStorage,
          readAudioObject: async (key) => Buffer.from(await input.storage.readObject(key)),
          synthesisTimeoutMs: Math.max(input.ttsPlaybackSegmentTimeoutMs, 1_000),
          onBeforeSegment,
          onSegmentCompleted,
          onSegmentErrored: async () => {
            await hooks?.onProgress?.({ completedThroughOrdinal: lastCompletedThrough, plannedCount });
          },
        });

        // Only finalize (→ ENDLIST) when we generated the whole plan. On an early
        // stop the session was superseded/expired/disconnected — leave its status
        // alone so we don't clobber a `canceled` set by a newer session.
        if (!stoppedEarly) {
          await playbackStorage.sessions.patchSession(parsed.sessionId, {
            status: 'succeeded',
            planObjectKey,
            lastError: null,
          });
        }
        return {
          sessionId: parsed.sessionId,
          planObjectKey,
          timing: { queueWaitMs, computeMs: Date.now() - startedAt },
        };
      } catch (error) {
        await playbackStorage.sessions.patchSession(parsed.sessionId, {
          status: 'failed',
          lastError: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        throw error;
      }
    },

    async runTtsPlaybackPlan(payload, queueWaitMs) {
      const parsed = ttsPlaybackPlanRequestSchema.parse(payload);
      const startedAt = Date.now();
      const planRequest = {
        ...parsed,
        sessionId: `plan:${parsed.documentId}:${parsed.settingsHash}`,
      } satisfies z.infer<typeof ttsPlaybackRequestSchema>;
      const plan = await resolveAndPersistTtsPlaybackPlan({
        request: planRequest,
        storage: input.storage,
        s3Prefix: input.s3Prefix,
      });
      return {
        planObjectKey: plan.planObjectKey,
        planSignature: plan.planSignature,
        startOrdinal: plan.startOrdinal,
        plannedCount: plan.plannedSegments.length,
        timing: { queueWaitMs, computeMs: Date.now() - startedAt },
      };
    },
  };
}
