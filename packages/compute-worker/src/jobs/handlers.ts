import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { generateTTSBuffer } from '@openreader/tts/generate';
import { getUpstreamRetryAfterSeconds, getUpstreamStatus } from '@openreader/tts/upstream-response';
import {
  buildTtsPlaybackSegmentAudioKey,
  buildTtsPlaybackAudioContentHash,
  buildTtsSegmentTextHash,
  computeSegmentationSignature,
  locatorFingerprint,
  normalizeLocator,
  normalizeSegmentText,
  probeAudioDurationMsFromBuffer,
} from '@openreader/tts/segments';
import type { TTSSegmentLocator, TTSSegmentSettings } from '@openreader/tts/types';
import { isHtmlLocator, isPdfLocator, isStableEpubLocator } from '@openreader/tts/types';
import { locatorGroupKey } from '@openreader/tts/locator';
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
import {
  accountExportArtifactKey,
  accountExportMetadataArtifactKey,
  documentPreviewArtifactKey,
  documentPreviewMetadataArtifactKey,
  documentConversionArtifactKey,
  documentConversionMetadataArtifactKey,
  documentSourceKey,
  parsedPdfArtifactKey,
  ttsPlaybackExportArtifactKey,
  ttsPlaybackExportMetadataArtifactKey,
  ttsPlaybackPlanArtifactKey,
} from '../storage/artifact-addressing';
import { extractEpubSpine } from '../inference/epub/spine-text';
import { DOCX_CONVERTER_VERSION, DOCUMENT_PREVIEW_RENDERER_VERSION, type ParsedPdfDocument } from '../operations/contracts';
import {
  runPdfLayoutFromPdfBuffer,
  runWhisperAlignmentFromAudioBuffer,
} from '../inference/runtime';
import { withIdleTimeoutAndHardCap, withTimeout } from '../infrastructure/config';
import type {
  DocumentPreviewArtifactMetadata,
  DocumentPreviewJobRequest,
  DocumentPreviewJobResult,
  DocumentConversionArtifactMetadata,
  DocumentConversionJobRequest,
  DocumentConversionJobResult,
  DocumentConversionProgress,
  AccountExportArtifactMetadata,
  AccountExportJobRequest,
  AccountExportJobResult,
  AccountExportProgress,
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  PdfLayoutProgress,
  TtsPlaybackJobRequest,
  TtsPlaybackJobResult,
  TtsPlaybackPlanJobRequest,
  TtsPlaybackPlanJobResult,
  TtsPlaybackExportArtifactMetadata,
  TtsPlaybackExportArtifactRequest,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackExportProgress,
  TtsPlaybackProgress,
} from '../operations/contracts';
import type { ArtifactStorage } from '../infrastructure/storage';
import type { TtsPlaybackStorage } from '../playback/storage';
import { generationFloorForCursor } from '../playback/generation-window';
import { persistParsedPdfWhileSourceExists } from './pdf-artifact-persistence';
import { buildInferProgressForPageParsed, buildInferProgressForPageStart } from './pdf-progress';
import { resolveTtsCredentials } from './tts-credentials';
import { renderEpubCoverToJpeg, renderPdfFirstPageToJpeg } from './document-preview-render';
import { convertDocxBufferToPdfBuffer } from '../inference/docx/convert';
import { buildAccountExportArchive, type AccountExportManifest } from './account-export-archive';

const pdfRequestSchema = z.object({
  documentId: z.string().trim().min(1),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentObjectKey: z.string().trim().min(1).max(2048),
});

const documentPreviewRequestSchema = z.object({
  documentId: z.string().trim().min(1),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentType: z.enum(['pdf', 'epub']),
  sourceObjectKey: z.string().trim().min(1).max(2048),
  sourceLastModifiedMs: z.number().int().nonnegative(),
  previewKind: z.literal('card'),
  rendererVersion: z.string().trim().min(1).max(256).optional(),
  targetWidth: z.number().int().positive().max(2048).optional(),
}).strict();

const documentConversionRequestSchema = z.object({
  conversionId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  namespace: z.string().trim().min(1).max(128).nullable(),
  sourceObjectKey: z.string().trim().min(1).max(2048),
  sourceLastModifiedMs: z.number().int().nonnegative(),
  sourceContentType: z.string().trim().min(1).max(256),
  sourceEtag: z.string().trim().min(1).max(256).nullable().optional(),
  converterVersion: z.string().trim().min(1).max(256).optional(),
}).strict();

const accountExportRequestSchema = z.object({
  artifactId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  namespace: z.string().trim().min(1).max(128).nullable(),
  schemaVersion: z.number().int().positive(),
  manifestHash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
  manifestObjectKey: z.string().trim().min(1).max(2048),
}).strict();

const ttsPlaybackPlanningSchema = z.object({
  selectedOrdinal: z.number().int().nonnegative().optional(),
  maxBlockLength: z.number().int().positive().max(20_000).optional(),
  enforceSourceBoundaries: z.boolean().optional(),
  language: z.string().trim().min(1).max(32).optional(),
  documentSource: z.object({
    namespace: z.string().trim().min(1).max(128).nullable(),
    skipBlockKinds: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    extent: z.enum(['section', 'document']),
    isPlainText: z.boolean().optional(),
  }).strict().optional(),
}).strict();

const ttsPlaybackPlanRequestSchema = z.object({
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  documentId: z.string().trim().min(1),
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  settingsJson: z.unknown(),
  planning: ttsPlaybackPlanningSchema,
}).strict();

const ttsPlaybackRequestSchema = ttsPlaybackPlanRequestSchema.extend({
  sessionId: z.string().trim().min(1).max(128),
  planObjectKey: z.string().trim().min(1).max(2048),
  generationRunId: z.string().trim().min(1).max(128).optional(),
  expiresAt: z.number().int().positive().optional(),
  aheadWindow: z.number().int().positive().max(4096).optional(),
  backgroundExtent: z.enum(['section', 'document']).optional(),
  generationExtent: z.enum(['window', 'document']).optional(),
}).strict();

const ttsPlaybackExportArtifactRequestSchema = z.object({
  artifactId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  sessionId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  documentId: z.string().trim().min(1),
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  settingsJson: z.unknown(),
  planObjectKey: z.string().trim().min(1).max(2048),
  format: z.enum(['mp3', 'm4b']),
  speed: z.number().min(0.5).max(3),
}).strict();

type TtsPlaybackPlanCapableRequest = z.infer<typeof ttsPlaybackPlanRequestSchema> & {
  sessionId: string;
  planObjectKey?: string;
};

// Sliding-window pacing constants for bounded forward-generation runs.
const TTS_PLAYBACK_DEFAULT_AHEAD_WINDOW = 8;
// How long after the client's last cursor write we still treat it as connected.
// Past this the client is assumed disconnected (JS suspended / tab closed) and
// generation switches to "background" mode bounded by `backgroundExtent`.
const TTS_PLAYBACK_CURSOR_STALE_MS = 15_000;
const TTS_PLAYBACK_GENERATION_LEASE_MIN_MS = 60_000;
const TTS_PLAYBACK_GENERATION_LEASE_GRACE_MS = 30_000;

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
  ordinal: number;
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
  request: TtsPlaybackPlanCapableRequest,
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
  request: TtsPlaybackPlanCapableRequest,
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
    ordinal: index,
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
  request: TtsPlaybackPlanCapableRequest,
): number {
  if (segments.length === 0) return 0;
  const planning = request.planning;
  if (planning.selectedOrdinal === undefined) {
    throw new Error('TTS playback start requires a worker-plan ordinal');
  }
  const selectedOrdinal = Math.max(0, Math.floor(planning.selectedOrdinal));
  const match = segments.find((segment) => segment.ordinal === selectedOrdinal);
  if (!match) {
    throw new Error(`TTS playback start ordinal ${selectedOrdinal} is not present in the canonical plan`);
  }
  return match.ordinal;
}

/**
 * Deterministic hash of the segmentation knobs that affect plan shape (but NOT
 * voice/speed, which only affect audio). Two sessions over the same document
 * version + reader type with the same knobs share one cached canonical plan.
 */
export function computePlaybackPlanSignature(
  request: TtsPlaybackPlanCapableRequest,
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
  request: TtsPlaybackPlanCapableRequest;
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
      ordinal: segment.ordinal,
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
  return parsed.segments.map((row): TtsPlaybackSegmentInput => {
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

async function resolveAndPersistTtsPlaybackPlan(input: {
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
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  deleteAudioObject?: (key: string) => Promise<void>;
  /** Content-addressed existence check: the source of truth for "already generated". */
  audioObjectExists: (key: string) => Promise<boolean>;
  playbackStorage?: TtsPlaybackStorage;
  /** Read previously-stored segment audio back (for the alignment self-heal path). */
  readAudioObject?: (key: string) => Promise<Buffer>;
  cacheEpoch?: number;
  getCurrentCacheEpoch?: () => Promise<number>;
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
    const audioContentHash = buildTtsPlaybackAudioContentHash({
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      settingsHash: input.request.settingsHash,
      ordinal: segment.ordinal,
      segmentKey,
      normalizedText: text,
      locatorFingerprint: locatorHash,
    });
    return {
      original: segment,
      text,
      audioContentHash,
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
      ordinal: segment.original.ordinal,
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
      cacheKey: audioKey,
    }).then((result) => {
      const first = result.alignments[0];
      return first ? { ...first, sentenceIndex: segment.original.ordinal } : null;
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
      leaseOwnerId?: string | null;
      updatedAt?: number;
    },
  ): Promise<void> => {
    if (!input.playbackStorage) return;
    if (input.cacheEpoch !== undefined && input.getCurrentCacheEpoch) {
      const currentEpoch = await input.getCurrentCacheEpoch();
      if (currentEpoch !== input.cacheEpoch) return;
    }
    const updatedAt = metadata.updatedAt ?? Date.now();
    await input.playbackStorage.artifacts.putSegmentMetadata({
      schemaVersion: 1,
      ...(input.cacheEpoch === undefined ? {} : { cacheEpoch: input.cacheEpoch }),
      status,
      storageUserId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      readerType: input.request.readerType,
      settingsHash: input.request.settingsHash,
      settingsJson: input.request.settingsJson,
      ordinal: segment.original.ordinal,
      segmentKey: segment.segmentKey,
      textHash: segment.textHash,
      textLength: segment.text.length,
      audioKey: metadata.audioKey,
      audioFormat: 'mp3',
      durationMs: metadata.durationMs ?? null,
      alignment: metadata.alignment ?? null,
      error: metadata.error ?? null,
      leaseOwnerId: metadata.leaseOwnerId ?? null,
      leaseUpdatedAt: status === 'generating' ? updatedAt : null,
      updatedAt,
    });
  };

  const shouldContinueWrites = async (planOrdinal: number): Promise<boolean> => {
    if (input.onBeforeSegment) {
      const decision = await input.onBeforeSegment(planOrdinal);
      if (decision === 'stop') return false;
    }
    if (input.cacheEpoch !== undefined && input.getCurrentCacheEpoch) {
      const currentEpoch = await input.getCurrentCacheEpoch();
      if (currentEpoch !== input.cacheEpoch) return false;
    }
    return true;
  };

  const leaseOwnerId = [
    input.request.sessionId,
    input.request.generationExtent ?? 'window',
    input.request.generationRunId ?? 'initial',
  ].join(':');
  const leaseStaleMs = Math.max(
    TTS_PLAYBACK_GENERATION_LEASE_MIN_MS,
    input.synthesisTimeoutMs + TTS_PLAYBACK_GENERATION_LEASE_GRACE_MS,
  );
  const minCacheEpoch = Math.max(0, Math.floor(Number(input.cacheEpoch ?? 0)));
  const freshSidecar = async (segment: (typeof normalized)[number]) => {
    const raw = await readSidecar(segment).catch(() => null);
    return raw && Math.max(0, Math.floor(Number(raw.cacheEpoch ?? 0))) >= minCacheEpoch ? raw : null;
  };
  const isFreshForeignLease = (
    sidecar: Awaited<ReturnType<typeof freshSidecar>>,
    audioKey: string,
    now = Date.now(),
  ): boolean => {
    if (!sidecar || sidecar.status !== 'generating') return false;
    if (sidecar.audioKey !== audioKey) return false;
    if (!sidecar.leaseOwnerId || sidecar.leaseOwnerId === leaseOwnerId) return false;
    const leaseUpdatedAt = Number(sidecar.leaseUpdatedAt ?? sidecar.updatedAt ?? 0);
    return Number.isFinite(leaseUpdatedAt) && now - leaseUpdatedAt < leaseStaleMs;
  };

  segmentLoop:
  for (const segment of normalized) {
    // The pacing gate is the single stop/cancel point: it reads session status +
    // cursor and returns 'stop' when the session was superseded/expired (so a
    // canceled session ends gracefully here rather than throwing → 'failed').
    const planOrdinal = segment.original.ordinal;
    if (input.onBeforeSegment) {
      const decision = await input.onBeforeSegment(planOrdinal);
      if (decision === 'stop') break;
    }

    // The segment audio is content-addressed: the same text+voice+model+settings
    // always hashes to the same key. The audio object remains the source of
    // truth for completed work; a `generating` sidecar is only an in-progress
    // lease to avoid duplicate cold synthesis.
    const audioKey = buildTtsPlaybackSegmentAudioKey({
      storagePrefix: input.s3Prefix,
      namespace: null,
      userId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      settingsHash: input.request.settingsHash,
      audioContentHash: segment.audioContentHash,
    });

    let existing = await freshSidecar(segment);
    const audioExists = await input.audioObjectExists(audioKey).catch(() => false);

    if (audioExists) {
      if (!await shouldContinueWrites(planOrdinal)) break;
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
      if (needsRebuild && await shouldContinueWrites(planOrdinal)) {
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

    while (isFreshForeignLease(existing, audioKey)) {
      if (!await shouldContinueWrites(planOrdinal)) break segmentLoop;
      await sleep(1_000);
      existing = await freshSidecar(segment);
      if (existing?.status === 'completed') {
        await input.onSegmentCompleted?.(planOrdinal);
        continue segmentLoop;
      }
      if (existing?.status === 'error') {
        await input.onSegmentErrored?.(planOrdinal);
        continue segmentLoop;
      }
    }

    if (!await shouldContinueWrites(planOrdinal)) break;
    await persistSegmentMetadata(segment, 'generating', {
      audioKey,
      leaseOwnerId,
      updatedAt: Date.now(),
    }).catch(() => undefined);
    existing = await freshSidecar(segment);
    while (isFreshForeignLease(existing, audioKey)) {
      if (!await shouldContinueWrites(planOrdinal)) break segmentLoop;
      await sleep(1_000);
      existing = await freshSidecar(segment);
      if (existing?.status === 'completed') {
        await input.onSegmentCompleted?.(planOrdinal);
        continue segmentLoop;
      }
      if (existing?.status === 'error') {
        await input.onSegmentErrored?.(planOrdinal);
        continue segmentLoop;
      }
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
        if (!await shouldContinueWrites(planOrdinal)) return;
        await input.putAudioObject(audioKey, audioBuffer);
        if (!await shouldContinueWrites(planOrdinal)) {
          await input.deleteAudioObject?.(audioKey).catch(() => undefined);
          return;
        }
        const durationMs = await probeAudioDurationMsFromBuffer(audioBuffer).catch(() => 0);
        const alignment = await computeAlignment(audioBuffer, segment, audioKey);

        if (!await shouldContinueWrites(planOrdinal)) return;
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
    if (!await shouldContinueWrites(planOrdinal)) break;
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

type ExportChapter = {
  title: string;
  startMs: number;
  endMs: number;
};

function speedNeedsTranscode(speed: number): boolean {
  return Math.abs(speed - 1) >= 0.01;
}

function formatSpeedForFilename(speed: number): string {
  return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
}

function contentTypeForExportFormat(format: 'mp3' | 'm4b'): string {
  return format === 'm4b' ? 'audio/mp4' : 'audio/mpeg';
}

function buildExportFilename(input: {
  documentId: string;
  speed: number;
  format: 'mp3' | 'm4b';
}): string {
  const speedSuffix = speedNeedsTranscode(input.speed) ? `-${formatSpeedForFilename(input.speed)}x` : '';
  return `openreader-${input.documentId.slice(0, 12)}${speedSuffix}.${input.format}`;
}

function stripId3Tag(bytes: Buffer): Buffer {
  if (bytes.length < 10 || bytes.subarray(0, 3).toString('ascii') !== 'ID3') return bytes;
  const size =
    ((bytes[6] & 0x7f) << 21)
    | ((bytes[7] & 0x7f) << 14)
    | ((bytes[8] & 0x7f) << 7)
    | (bytes[9] & 0x7f);
  const end = 10 + size;
  return end > 0 && end < bytes.length ? bytes.subarray(end) : bytes;
}

function buildAtempoFilter(speed: number): string {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters.join(',');
}

function escapeFfmetadataValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/=/g, '\\=')
    .replace(/;/g, '\\;')
    .replace(/#/g, '\\#');
}

function fallbackChapterTitle(locator: TTSSegmentLocator | null, index: number): string {
  if (isPdfLocator(locator)) return `Page ${Math.max(1, Math.floor(locator.page))}`;
  if (isStableEpubLocator(locator)) return `Chapter ${index}`;
  if (isHtmlLocator(locator)) return index === 1 ? 'Document' : `Section ${index}`;
  return `Chapter ${index}`;
}

function buildExportChapters(input: {
  segments: TtsPlaybackSegmentInput[];
  durationsByOrdinal: Map<number, number>;
  speed: number;
}): ExportChapter[] {
  const speed = Math.max(0.5, Math.min(3, Number.isFinite(input.speed) ? input.speed : 1));
  const chapters: ExportChapter[] = [];
  let activeGroup: string | null = null;
  let activeLocator: TTSSegmentLocator | null = null;
  let activeStartMs = 0;
  let cursorMs = 0;

  for (const segment of input.segments) {
    const group = locatorGroupKey(normalizeLocator(segment.locator as never));
    if (activeGroup === null) {
      activeGroup = group;
      activeLocator = normalizeLocator(segment.locator as never);
      activeStartMs = cursorMs;
    } else if (group !== activeGroup) {
      const chapterIndex = chapters.length + 1;
      chapters.push({
        title: fallbackChapterTitle(activeLocator, chapterIndex),
        startMs: Math.max(0, Math.floor(activeStartMs / speed)),
        endMs: Math.max(0, Math.floor(cursorMs / speed)),
      });
      activeGroup = group;
      activeLocator = normalizeLocator(segment.locator as never);
      activeStartMs = cursorMs;
    }
    cursorMs += Math.max(1, Math.floor(input.durationsByOrdinal.get(segment.ordinal) ?? 1000));
  }

  if (activeGroup !== null) {
    const chapterIndex = chapters.length + 1;
    chapters.push({
      title: fallbackChapterTitle(activeLocator, chapterIndex),
      startMs: Math.max(0, Math.floor(activeStartMs / speed)),
      endMs: Math.max(0, Math.ceil(cursorMs / speed)),
    });
  }

  return chapters
    .map((chapter, index, all) => ({
      ...chapter,
      endMs: Math.max(chapter.startMs + 1, Math.min(chapter.endMs, all[index + 1]?.startMs ?? chapter.endMs)),
    }))
    .filter((chapter) => chapter.endMs > chapter.startMs);
}

function buildFfmetadata(input: {
  title: string;
  chapters: ExportChapter[];
}): string {
  const lines = [
    ';FFMETADATA1',
    `title=${escapeFfmetadataValue(input.title)}`,
  ];
  for (const chapter of input.chapters) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.max(0, Math.floor(chapter.startMs))}`,
      `END=${Math.max(0, Math.floor(chapter.endMs))}`,
      `title=${escapeFfmetadataValue(chapter.title)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function runFfmpegExport(input: {
  source: Buffer;
  format: 'mp3' | 'm4b';
  speed: number;
  title: string;
  chapters: ExportChapter[];
}): Promise<Buffer> {
  const executable = ffmpegPath;
  if (!executable) {
    throw new Error('ffmpeg-static did not provide an executable path');
  }
  const workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-export-'));
  const inputPath = join(workDir, 'input.mp3');
  const outputPath = join(workDir, input.format === 'm4b' ? 'audiobook.m4b' : 'audiobook.mp3');
  const metadataPath = join(workDir, 'chapters.ffmetadata');
  await writeFile(inputPath, input.source);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
  ];

  if (input.format === 'm4b') {
    await writeFile(metadataPath, buildFfmetadata({
      title: input.title,
      chapters: input.chapters,
    }), 'utf8');
    args.push('-f', 'ffmetadata', '-i', metadataPath);
  }

  if (speedNeedsTranscode(input.speed)) {
    args.push('-filter:a', buildAtempoFilter(input.speed));
  }

  if (input.format === 'm4b') {
    args.push(
      '-vn',
      '-map',
      '0:a:0',
      '-codec:a',
      'aac',
      '-b:a',
      '128k',
      '-map_metadata',
      '1',
      '-map_chapters',
      '1',
      '-f',
      'mp4',
      '-brand',
      'M4B ',
      '-movflags',
      '+faststart',
      outputPath,
    );
  } else {
    args.push('-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', outputPath);
  }

  try {
    const stderr: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(Buffer.from(chunk));
        if (stderr.length > 16) stderr.shift();
      });
      child.on('error', reject);
      child.on('close', (code: number | null) => {
        if (code) {
          const detail = Buffer.concat(stderr).toString('utf8').slice(-500);
          reject(new Error(`ffmpeg audiobook export failed with code ${code}: ${detail}`));
          return;
        }
        resolve();
      });
    });
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
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
  runTtsPlaybackExportArtifact(
    payload: TtsPlaybackExportArtifactRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: TtsPlaybackExportProgress) => Promise<void> },
  ): Promise<TtsPlaybackExportArtifactResult>;
  runDocumentPreview(
    payload: DocumentPreviewJobRequest,
    queueWaitMs: number,
  ): Promise<DocumentPreviewJobResult>;
  runDocumentConversion(
    payload: DocumentConversionJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: DocumentConversionProgress) => Promise<void> },
  ): Promise<DocumentConversionJobResult>;
  runAccountExport(
    payload: AccountExportJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: AccountExportProgress) => Promise<void> },
  ): Promise<AccountExportJobResult>;
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

    async runDocumentPreview(payload, queueWaitMs) {
      const parsed = documentPreviewRequestSchema.parse(payload);
      const s3FetchStartedAt = Date.now();
      const sourceBytes = Buffer.from(await withTimeout(
        input.storage.readObject(parsed.sourceObjectKey),
        Math.max(input.pdfTimeoutMs, 1_000),
        'document preview source fetch',
      ));
      const s3FetchMs = Date.now() - s3FetchStartedAt;

      const computeStartedAt = Date.now();
      const rendered = parsed.documentType === 'pdf'
        ? await renderPdfFirstPageToJpeg(sourceBytes, parsed.targetWidth ?? 400)
        : await renderEpubCoverToJpeg(sourceBytes, parsed.targetWidth ?? 400);
      const computeMs = Date.now() - computeStartedAt;

      const objectKey = documentPreviewArtifactKey({
        documentId: parsed.documentId,
        namespace: parsed.namespace,
        prefix: input.s3Prefix,
      });
      const metadataObjectKey = documentPreviewMetadataArtifactKey({
        documentId: parsed.documentId,
        namespace: parsed.namespace,
        prefix: input.s3Prefix,
      });
      await input.storage.putObject(objectKey, rendered.bytes, 'image/jpeg');
      const artifact: DocumentPreviewArtifactMetadata = {
        schemaVersion: 1,
        documentId: parsed.documentId,
        namespace: parsed.namespace,
        documentType: parsed.documentType,
        sourceObjectKey: parsed.sourceObjectKey,
        sourceLastModifiedMs: parsed.sourceLastModifiedMs,
        previewKind: parsed.previewKind,
        rendererVersion: parsed.rendererVersion?.trim() || DOCUMENT_PREVIEW_RENDERER_VERSION,
        objectKey,
        metadataObjectKey,
        contentType: 'image/jpeg',
        width: rendered.width,
        height: rendered.height,
        byteLength: rendered.bytes.byteLength,
        eTag: null,
        status: 'ready',
        createdAt: Date.now(),
      };
      await input.storage.putObject(metadataObjectKey, Buffer.from(JSON.stringify(artifact)), 'application/json');
      return {
        artifact,
        timing: { queueWaitMs, s3FetchMs, computeMs },
      };
    },

    async runDocumentConversion(payload, queueWaitMs, hooks) {
      const parsed = documentConversionRequestSchema.parse(payload);
      const metadataObjectKey = documentConversionMetadataArtifactKey({
        conversionId: parsed.conversionId,
        namespace: parsed.namespace,
        prefix: input.s3Prefix,
      });
      const existingMetadata = await input.storage.readObject(metadataObjectKey)
        .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as DocumentConversionArtifactMetadata)
        .catch(() => null);
      if (
        existingMetadata?.schemaVersion === 1
        && existingMetadata.status === 'ready'
        && existingMetadata.sourceObjectKey === parsed.sourceObjectKey
        && existingMetadata.sourceLastModifiedMs === parsed.sourceLastModifiedMs
        && existingMetadata.sourceContentType === parsed.sourceContentType
        && existingMetadata.sourceEtag === (parsed.sourceEtag ?? null)
        && await input.storage.objectExists(existingMetadata.objectKey).catch(() => false)
      ) {
        return {
          artifact: existingMetadata,
          timing: { queueWaitMs, computeMs: 0 },
        };
      }

      await hooks?.onProgress?.({ phase: 'fetching' });
      const s3FetchStartedAt = Date.now();
      const sourceBytes = Buffer.from(await withTimeout(
        input.storage.readObject(parsed.sourceObjectKey),
        Math.max(input.pdfTimeoutMs, 1_000),
        'docx conversion source fetch',
      ));
      const s3FetchMs = Date.now() - s3FetchStartedAt;

      await hooks?.onProgress?.({ phase: 'converting' });
      const computeStartedAt = Date.now();
      const pdfBytes = await convertDocxBufferToPdfBuffer(sourceBytes);
      const computeMs = Date.now() - computeStartedAt;

      await hooks?.onProgress?.({ phase: 'uploading' });
      const objectKey = documentConversionArtifactKey({
        conversionId: parsed.conversionId,
        namespace: parsed.namespace,
        prefix: input.s3Prefix,
      });
      const documentId = createHash('sha256').update(pdfBytes).digest('hex');
      await input.storage.putObject(objectKey, pdfBytes, 'application/pdf');
      const artifact: DocumentConversionArtifactMetadata = {
        schemaVersion: 1,
        conversionId: parsed.conversionId,
        namespace: parsed.namespace,
        sourceObjectKey: parsed.sourceObjectKey,
        sourceLastModifiedMs: parsed.sourceLastModifiedMs,
        sourceContentType: parsed.sourceContentType,
        sourceEtag: parsed.sourceEtag ?? null,
        converterVersion: parsed.converterVersion?.trim() || DOCX_CONVERTER_VERSION,
        objectKey,
        metadataObjectKey,
        contentType: 'application/pdf',
        byteLength: pdfBytes.byteLength,
        documentId,
        status: 'ready',
        createdAt: Date.now(),
      };
      await input.storage.putObject(metadataObjectKey, Buffer.from(JSON.stringify(artifact)), 'application/json');

      return {
        artifact,
        timing: { queueWaitMs, s3FetchMs, computeMs },
      };
    },

    async runAccountExport(payload, queueWaitMs, hooks) {
      const parsed = accountExportRequestSchema.parse(payload);
      const startedAt = Date.now();
      const metadataObjectKey = accountExportMetadataArtifactKey({
        artifactId: parsed.artifactId,
        storageUserId: parsed.storageUserId,
        namespace: parsed.namespace,
        prefix: input.s3Prefix,
      });
      const existingMetadata = await input.storage.readObject(metadataObjectKey)
        .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as AccountExportArtifactMetadata)
        .catch(() => null);
      if (
        existingMetadata?.schemaVersion === 1
        && existingMetadata.status === 'ready'
        && existingMetadata.userId === parsed.userId
        && existingMetadata.storageUserId === parsed.storageUserId
        && existingMetadata.namespace === parsed.namespace
        && existingMetadata.exportSchemaVersion === parsed.schemaVersion
        && existingMetadata.manifestHash === parsed.manifestHash
        && await input.storage.objectExists(existingMetadata.objectKey).catch(() => false)
      ) {
        return {
          artifact: existingMetadata,
          timing: { queueWaitMs, computeMs: Date.now() - startedAt },
        };
      }

      const manifestBytes = await input.storage.readObject(parsed.manifestObjectKey);
      const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as AccountExportManifest;
      if (
        manifest.userId !== parsed.userId
        || manifest.storageUserId !== parsed.storageUserId
        || manifest.namespace !== parsed.namespace
        || manifest.schemaVersion !== parsed.schemaVersion
      ) {
        throw new Error('Account export manifest scope mismatch');
      }

      const archive = await buildAccountExportArchive({
        manifest,
        readObject: input.storage.readObject,
        onProgress: hooks?.onProgress,
      });
      const objectKey = accountExportArtifactKey({
        artifactId: parsed.artifactId,
        storageUserId: parsed.storageUserId,
        namespace: parsed.namespace,
        prefix: input.s3Prefix,
      });
      await input.storage.putObject(objectKey, archive, 'application/zip');
      const artifact: AccountExportArtifactMetadata = {
        schemaVersion: 1,
        artifactId: parsed.artifactId,
        userId: parsed.userId,
        storageUserId: parsed.storageUserId,
        namespace: parsed.namespace,
        exportSchemaVersion: parsed.schemaVersion,
        manifestHash: parsed.manifestHash,
        manifestObjectKey: parsed.manifestObjectKey,
        objectKey,
        contentType: 'application/zip',
        byteLength: archive.byteLength,
        dispositionFilename: `openreader-data-${parsed.storageUserId.slice(0, 8)}.zip`,
        status: 'ready',
        createdAt: Date.now(),
      };
      await input.storage.putObject(metadataObjectKey, Buffer.from(JSON.stringify(artifact)), 'application/json');
      await hooks?.onProgress?.({
        phase: 'uploading',
        completedFiles: manifest.files.length,
        plannedFiles: manifest.files.length,
      });
      return {
        artifact,
        timing: { queueWaitMs, computeMs: Date.now() - startedAt },
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
        const lastOrdinal = plannedSegments.reduce((max, s) => Math.max(max, s.ordinal), -1);
        const plannedCount = plannedSegments.length;
        const aheadWindow = parsed.aheadWindow ?? TTS_PLAYBACK_DEFAULT_AHEAD_WINDOW;
        const backgroundExtent = parsed.backgroundExtent ?? 'section';
        const forceDocumentExtent = parsed.generationExtent === 'document';
        const readCurrentCacheEpoch = async (): Promise<number> => await playbackStorage.artifacts.getScopeEpoch({
          storageUserId: parsed.storageUserId,
          documentId: parsed.documentId,
          documentVersion: parsed.documentVersion,
          settingsHash: parsed.settingsHash,
        });
        const cacheEpoch = await readCurrentCacheEpoch();
        const completedOrdinals = new Set<number>();
        const scanCompletedSidecars = async (): Promise<void> => {
          const batchSize = 32;
          for (let i = 0; i < plannedSegments.length; i += batchSize) {
            const batch = plannedSegments.slice(i, i + batchSize);
            const sidecars = await Promise.all(batch.map((segment) => playbackStorage.artifacts.readSegmentMetadata({
              storageUserId: parsed.storageUserId,
              documentId: parsed.documentId,
              documentVersion: parsed.documentVersion,
              settingsHash: parsed.settingsHash,
              ordinal: segment.ordinal,
            }).catch(() => null)));
            sidecars.forEach((sidecar) => {
              if (sidecar?.status !== 'completed' || !sidecar.audioKey) return;
              if (Math.max(0, Math.floor(Number(sidecar.cacheEpoch ?? 0))) < cacheEpoch) return;
              completedOrdinals.add(sidecar.ordinal);
            });
          }
        };

        // Section map (for background-extent bounding) + ordered ordinals.
        const sectionByOrdinal = new Map<number, string | null>();
        for (const segment of plannedSegments) {
          sectionByOrdinal.set(segment.ordinal, playbackSectionKey(segment.locator, parsed.readerType));
        }
        const orderedOrdinals = plannedSegments.map((s) => s.ordinal).sort((a, b) => a - b);
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
        const emitProgress = async (): Promise<void> => {
          await hooks?.onProgress?.({
            completedThroughOrdinal: lastCompletedThrough,
            completedCount: completedOrdinals.size,
            plannedCount,
          });
        };
        await scanCompletedSidecars();
        if (completedOrdinals.size > 0) {
          lastCompletedThrough = Math.max(...completedOrdinals);
        }
        await emitProgress();

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
          if (forceDocumentExtent) {
            return 'continue';
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
          completedOrdinals.add(planOrdinal);
          if (planOrdinal > lastCompletedThrough) lastCompletedThrough = planOrdinal;
          await emitProgress();
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
        const generationSegments = forceDocumentExtent
          ? plannedSegments
          : plannedSegments.filter((segment) => segment.ordinal >= generationFloor);

        await generateExplicitTtsPlaybackSegments({
          request: parsed,
          s3Prefix: input.s3Prefix,
          segments: generationSegments,
          putAudioObject: (key, body) => input.storage.putObject(key, body, 'audio/mpeg'),
          deleteAudioObject: (key) => input.storage.deleteObject(key),
          audioObjectExists: (key) => input.storage.objectExists(key),
          playbackStorage,
          readAudioObject: async (key) => Buffer.from(await input.storage.readObject(key)),
          cacheEpoch,
          getCurrentCacheEpoch: readCurrentCacheEpoch,
          synthesisTimeoutMs: Math.max(input.ttsPlaybackSegmentTimeoutMs, 1_000),
          onBeforeSegment,
          onSegmentCompleted,
          onSegmentErrored: async () => {
            await emitProgress();
          },
        });
        const finalSession = await playbackStorage.sessions.getSession(parsed.sessionId).catch(() => null);
        if (!finalSession || (finalSession.status !== 'queued' && finalSession.status !== 'running')) {
          stoppedEarly = true;
        }
        if (await readCurrentCacheEpoch() !== cacheEpoch) {
          stoppedEarly = true;
        }

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
        const latest = await playbackStorage.sessions.getSession(parsed.sessionId).catch(() => null);
        if (latest?.status === 'queued' || latest?.status === 'running') {
          await playbackStorage.sessions.patchSession(parsed.sessionId, {
            status: 'failed',
            lastError: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined);
        }
        throw error;
      }
    },

    async runTtsPlaybackPlan(payload, queueWaitMs) {
      const parsed = ttsPlaybackPlanRequestSchema.parse(payload);
      const startedAt = Date.now();
      const planRequest = {
        ...parsed,
        sessionId: `plan:${parsed.documentId}:${parsed.settingsHash}`,
      } satisfies TtsPlaybackPlanCapableRequest;
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

    async runTtsPlaybackExportArtifact(payload, queueWaitMs, hooks) {
      const parsed = ttsPlaybackExportArtifactRequestSchema.parse(payload);
      const startedAt = Date.now();
      if (!input.playbackStorage) {
        throw new Error('TTS playback storage is required');
      }

      const metadataKey = ttsPlaybackExportMetadataArtifactKey({
        artifactId: parsed.artifactId,
        storageUserId: parsed.storageUserId,
        documentId: parsed.documentId,
        prefix: input.s3Prefix,
      });
      const existingMetadata = await input.storage.readObject(metadataKey)
        .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as TtsPlaybackExportArtifactMetadata)
        .catch(() => null);
      if (
        existingMetadata?.schemaVersion === 1
        && existingMetadata.status === 'ready'
        && await input.storage.objectExists(existingMetadata.objectKey).catch(() => false)
      ) {
        return {
          artifact: existingMetadata,
          timing: { queueWaitMs, computeMs: Date.now() - startedAt },
        };
      }

      const session = await input.playbackStorage.sessions.getSession(parsed.sessionId);
      if (!session) throw new Error('TTS playback export session was not found');
      if (session.storageUserId !== parsed.storageUserId || session.documentId !== parsed.documentId) {
        throw new Error('TTS playback export session scope mismatch');
      }
      if (session.status !== 'succeeded') {
        throw new Error(`TTS playback export session is not complete: ${session.status}`);
      }
      if (session.planObjectKey !== parsed.planObjectKey) {
        throw new Error('TTS playback export session plan key mismatch');
      }

      const plannedSegments = await readPersistedTtsPlaybackPlanSegments(input.storage, parsed.planObjectKey);
      if (!plannedSegments || plannedSegments.length === 0) {
        throw new Error('TTS playback export requires a loaded canonical plan');
      }

      const durationsByOrdinal = new Map<number, number>();
      const audioKeysByOrdinal = new Map<number, string>();
      for (const segment of plannedSegments) {
        const sidecar = await input.playbackStorage.artifacts.readSegmentMetadata({
          storageUserId: parsed.storageUserId,
          documentId: parsed.documentId,
          documentVersion: parsed.documentVersion,
          settingsHash: parsed.settingsHash,
          ordinal: segment.ordinal,
        });
        if (sidecar?.status !== 'completed' || !sidecar.audioKey) {
          throw new Error(`TTS playback export is missing completed audio for ordinal ${segment.ordinal}`);
        }
        durationsByOrdinal.set(segment.ordinal, Math.max(1, Number(sidecar.durationMs ?? 1000)));
        audioKeysByOrdinal.set(segment.ordinal, sidecar.audioKey);
      }

      const chunks: Buffer[] = [];
      for (let index = 0; index < plannedSegments.length; index += 1) {
        const segment = plannedSegments[index]!;
        const audioKey = audioKeysByOrdinal.get(segment.ordinal);
        if (!audioKey) throw new Error(`TTS playback export is missing audio key for ordinal ${segment.ordinal}`);
        const raw = Buffer.from(await input.storage.readObject(audioKey));
        chunks.push(stripId3Tag(raw));
        await hooks?.onProgress?.({
          phase: 'assembling',
          completedSegments: index + 1,
          plannedSegments: plannedSegments.length,
        });
      }

      const baseMp3 = Buffer.concat(chunks);
      const chapters = buildExportChapters({
        segments: plannedSegments,
        durationsByOrdinal,
        speed: parsed.speed,
      });
      const needsFfmpeg = parsed.format === 'm4b' || speedNeedsTranscode(parsed.speed);
      await hooks?.onProgress?.({
        phase: needsFfmpeg ? 'transcoding' : 'uploading',
        completedSegments: plannedSegments.length,
        plannedSegments: plannedSegments.length,
      });
      const output = needsFfmpeg
        ? await runFfmpegExport({
          source: baseMp3,
          format: parsed.format,
          speed: parsed.speed,
          title: `OpenReader ${parsed.documentId.slice(0, 12)}`,
          chapters,
        })
        : baseMp3;

      const objectKey = ttsPlaybackExportArtifactKey({
        artifactId: parsed.artifactId,
        storageUserId: parsed.storageUserId,
        documentId: parsed.documentId,
        format: parsed.format,
        prefix: input.s3Prefix,
      });
      await input.storage.putObject(objectKey, output, contentTypeForExportFormat(parsed.format));
      const metadata: TtsPlaybackExportArtifactMetadata = {
        schemaVersion: 1,
        artifactId: parsed.artifactId,
        sessionId: parsed.sessionId,
        storageUserId: parsed.storageUserId,
        documentId: parsed.documentId,
        documentVersion: parsed.documentVersion,
        readerType: parsed.readerType,
        settingsHash: parsed.settingsHash,
        planObjectKey: parsed.planObjectKey,
        format: parsed.format,
        speed: parsed.speed,
        objectKey,
        contentType: contentTypeForExportFormat(parsed.format),
        byteLength: output.byteLength,
        dispositionFilename: buildExportFilename({
          documentId: parsed.documentId,
          speed: parsed.speed,
          format: parsed.format,
        }),
        sourceSessionId: parsed.sessionId,
        sourcePlanObjectKey: parsed.planObjectKey,
        status: 'ready',
        createdAt: Date.now(),
      };
      await input.storage.putObject(metadataKey, Buffer.from(JSON.stringify(metadata)), 'application/json');
      await hooks?.onProgress?.({
        phase: 'uploading',
        completedSegments: plannedSegments.length,
        plannedSegments: plannedSegments.length,
      });

      return {
        artifact: metadata,
        timing: { queueWaitMs, computeMs: Date.now() - startedAt },
      };
    },
  };
}
