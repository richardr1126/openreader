import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { ttsSegmentEntries, ttsSegmentVariants, ttsPlaybackSessions } from '@openreader/database/schema';
import { generateTTSBuffer } from '@openreader/tts/generate';
import {
  buildTtsSegmentAudioKey,
  buildTtsSegmentEntryId,
  buildTtsSegmentId,
  buildTtsSegmentTextHash,
  locatorFingerprint,
  normalizeLocator,
  normalizeSegmentText,
  probeAudioDurationMsFromBuffer,
  projectSegmentLocator,
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
  aheadWindow: z.number().int().positive().max(4096).optional(),
  backgroundExtent: z.enum(['section', 'document']).optional(),
  planning: z.object({
    startSegmentKey: z.string().trim().min(1).max(512).optional(),
    startText: z.string().trim().min(1).max(20_000).optional(),
    maxBlockLength: z.number().int().positive().max(20_000).optional(),
    enforceSourceBoundaries: z.boolean().optional(),
    language: z.string().trim().min(1).max(32).optional(),
    documentSource: z.object({
      namespace: z.string().trim().min(1).max(128).nullable(),
      skipBlockKinds: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
      extent: z.enum(['section', 'document']),
      startPage: z.number().int().positive().optional(),
      startSpineIndex: z.number().int().nonnegative().optional(),
      startCharOffset: z.number().int().nonnegative().optional(),
      isPlainText: z.boolean().optional(),
    }).optional(),
  }),
});

const ttsPlaybackPlanRequestSchema = ttsPlaybackRequestSchema
  .omit({ sessionId: true, planObjectKey: true, aheadWindow: true, backgroundExtent: true })
  .extend({});

async function updateTtsPlaybackSession(input: {
  sessionId: string;
  status: 'running' | 'succeeded' | 'failed';
  planObjectKey?: string;
  lastError?: string | null;
  /**
   * Absolute canonical ordinal the worker generates around AND the origin of the
   * progressive audio stream / byte+time layout. These are the same ordinal: the
   * stream begins at the resolved start (Chapter One/page N) with no silent
   * run-up in front of it. An earlier design kept the layout origin at 0 and
   * padded `[0, start)` with CBR silence, but that silence is sliced mid-frame
   * (the 1s silence unit isn't a whole number of MP3 frames), so its decoded
   * duration drifts shorter than its advertised byte length — the element seeks
   * past the silence into real audio and runs ahead of the highlight. The prefix
   * region is never generated anyway (see the generation filter below), so it
   * carried no audible content; dropping it removes the drift with no loss.
   */
  generationStartOrdinal?: number;
  /** Audio-layout origin. Kept equal to {@link generationStartOrdinal}. */
  startOrdinal?: number;
  cursorOrdinal?: number;
}): Promise<void> {
  const now = Date.now();
  const generationStartOrdinal = input.generationStartOrdinal === undefined
    ? undefined
    : Math.max(0, Math.floor(input.generationStartOrdinal));
  const startOrdinal = input.startOrdinal === undefined
    ? undefined
    : Math.max(0, Math.floor(input.startOrdinal));
  const cursorOrdinal = input.cursorOrdinal === undefined
    ? undefined
    : Math.max(0, Math.floor(input.cursorOrdinal));
  await db
    .update(ttsPlaybackSessions)
    .set({
      status: input.status,
      ...(input.planObjectKey === undefined ? {} : { planObjectKey: input.planObjectKey }),
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
      ...(generationStartOrdinal === undefined ? {} : { generationStartOrdinal }),
      ...(startOrdinal === undefined ? {} : { startOrdinal }),
      ...(cursorOrdinal === undefined
        ? {}
        : { cursorOrdinal, cursorUpdatedAt: now }),
      updatedAt: now,
    })
    .where(eq(ttsPlaybackSessions.sessionId, input.sessionId));
}

async function assertTtsPlaybackSessionActive(sessionId: string): Promise<void> {
  const rows = (await db
    .select({ status: ttsPlaybackSessions.status, lastError: ttsPlaybackSessions.lastError })
    .from(ttsPlaybackSessions)
    .where(eq(ttsPlaybackSessions.sessionId, sessionId))
    .limit(1)) as Array<{ status: string; lastError: string | null }>;
  const row = rows[0];
  if (!row) throw new Error('TTS playback session no longer exists');
  if (row.status !== 'queued' && row.status !== 'running') {
    throw new Error(row.lastError || `TTS playback session is ${row.status}`);
  }
}

// Sliding-window pacing constants for the single forward-generation job.
const TTS_PLAYBACK_DEFAULT_AHEAD_WINDOW = 8;
// How long after the client's last cursor write we still treat it as connected.
// Past this the client is assumed disconnected (JS suspended / tab closed) and
// generation switches to "background" mode bounded by `backgroundExtent`.
const TTS_PLAYBACK_CURSOR_STALE_MS = 15_000;
// Poll cadence while throttling ahead of a fresh cursor.
const TTS_PLAYBACK_THROTTLE_POLL_MS = 500;
// Minimum spacing between progress heartbeats while idling/throttling; each one
// extends the JetStream ack-wait (via the worker loop's onProgress → msg.working()).
const TTS_PLAYBACK_HEARTBEAT_MS = 5_000;

async function readTtsPlaybackSessionCursor(sessionId: string): Promise<{
  status: string;
  cursorOrdinal: number;
  cursorUpdatedAt: number | null;
  expiresAt: number;
} | null> {
  const rows = (await db
    .select({
      status: ttsPlaybackSessions.status,
      cursorOrdinal: ttsPlaybackSessions.cursorOrdinal,
      cursorUpdatedAt: ttsPlaybackSessions.cursorUpdatedAt,
      expiresAt: ttsPlaybackSessions.expiresAt,
    })
    .from(ttsPlaybackSessions)
    .where(eq(ttsPlaybackSessions.sessionId, sessionId))
    .limit(1)) as Array<{
      status: string;
      cursorOrdinal: number | null;
      cursorUpdatedAt: number | null;
      expiresAt: number;
    }>;
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    cursorOrdinal: Math.max(0, Math.floor(Number(row.cursorOrdinal ?? 0))),
    cursorUpdatedAt: row.cursorUpdatedAt == null ? null : Number(row.cursorUpdatedAt),
    expiresAt: Number(row.expiresAt),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function locatorPageNumber(locator: unknown): number | null {
  if (!locator || typeof locator !== 'object') return null;
  const rec = locator as { readerType?: unknown; page?: unknown };
  if (rec.readerType !== 'pdf') return null;
  const page = Number(rec.page);
  return Number.isFinite(page) ? page : null;
}

function locatorSpineIndex(locator: unknown): number | null {
  if (!locator || typeof locator !== 'object') return null;
  const rec = locator as { readerType?: unknown; spineIndex?: unknown };
  if (rec.readerType !== 'epub') return null;
  const spineIndex = Number(rec.spineIndex);
  return Number.isFinite(spineIndex) ? spineIndex : null;
}

function locatorCharOffset(locator: unknown): number | null {
  if (!locator || typeof locator !== 'object') return null;
  const rec = locator as { readerType?: unknown; charOffset?: unknown };
  if (rec.readerType !== 'epub') return null;
  const charOffset = Number(rec.charOffset);
  return Number.isFinite(charOffset) ? charOffset : null;
}

/**
 * Resolve the absolute canonical ordinal where playback should begin, given the
 * whole-document plan and the session's start hints. EPUB is coordinate-only:
 * rendered-window text and segment keys are not unique enough to choose a start
 * ordinal, so a missing coordinate match is a hard planning error.
 */
export function resolvePlaybackStartOrdinal(
  segments: TtsPlaybackSegmentInput[],
  request: z.infer<typeof ttsPlaybackRequestSchema>,
): number {
  if (segments.length === 0) return 0;
  const planning = request.planning;

  const documentSource = planning.documentSource;
  if (request.readerType === 'epub' && documentSource?.startSpineIndex !== undefined) {
    const startSpineIndex = Math.max(0, Math.floor(documentSource.startSpineIndex));
    const startCharOffset = documentSource.startCharOffset === undefined
      ? null
      : Math.max(0, Math.floor(documentSource.startCharOffset));
    const match = segments.find((segment) => {
      const spineIndex = locatorSpineIndex(segment.locator);
      if (spineIndex == null) return false;
      if (spineIndex > startSpineIndex) return true;
      if (spineIndex < startSpineIndex) return false;
      if (startCharOffset == null) return true;
      const charOffset = locatorCharOffset(segment.locator);
      return charOffset == null || charOffset >= startCharOffset;
    });
    if (match) return match.segmentIndex;
    throw new Error(`Unable to resolve EPUB playback start ordinal for spine ${startSpineIndex} at char offset ${startCharOffset ?? 0}`);
  }
  if (request.readerType === 'epub') {
    throw new Error('EPUB playback start requires stable spine coordinates');
  }

  if (planning.startSegmentKey) {
    const match = segments.find((segment) => segment.segmentKey === planning.startSegmentKey);
    if (match) return match.segmentIndex;
  }
  if (planning.startText) {
    const normalizedStartText = normalizeSegmentText(planning.startText);
    if (normalizedStartText) {
      const match = segments.find((segment) => normalizeSegmentText(segment.text) === normalizedStartText);
      if (match) return match.segmentIndex;
    }
  }

  if (documentSource) {
    if (request.readerType === 'pdf' && documentSource.startPage !== undefined) {
      const startPage = Math.max(1, Math.floor(documentSource.startPage));
      const match = segments.find((segment) => {
        const page = locatorPageNumber(segment.locator);
        return page != null && page >= startPage;
      });
      if (match) return match.segmentIndex;
    }
  }

  return segments[0].segmentIndex;
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
  const signature = {
    maxBlockLength: planning.maxBlockLength ?? null,
    language: planning.language ?? parseTtsSettings(request.settingsJson).language ?? null,
    enforceSourceBoundaries: Boolean(planning.enforceSourceBoundaries),
    skipBlockKinds: [...(documentSource?.skipBlockKinds ?? [])].map((kind) => kind.trim()).filter(Boolean).sort(),
    isPlainText: Boolean(documentSource?.isPlainText),
    namespace: documentSource?.namespace ?? null,
  };
  return createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 32);
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
}): Promise<{
  planObjectKey: string;
  planSignature: string;
  plannedSegments: TtsPlaybackSegmentInput[];
  startOrdinal: number;
}> {
  const planSignature = computePlaybackPlanSignature(input.request);
  const planObjectKey = ttsPlaybackPlanArtifactKey({
    documentId: input.request.documentId,
    documentVersion: input.request.documentVersion,
    readerType: input.request.readerType,
    planSignature,
    prefix: input.s3Prefix,
  });
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
    startOrdinal: resolvePlaybackStartOrdinal(plannedSegments, input.request),
  };
}

const SEGMENT_MAX_ATTEMPTS = 2;

async function generateExplicitTtsPlaybackSegments(input: {
  request: z.infer<typeof ttsPlaybackRequestSchema>;
  s3Prefix: string;
  segments: TtsPlaybackSegmentInput[];
  putAudioObject: (key: string, body: Buffer) => Promise<void>;
  /**
   * Pacing gate, called before each segment with its plan ordinal. Returns
   * 'continue' to generate it, 'stop' to end generation gracefully (the client
   * has fallen far enough behind / a background extent boundary is reached).
   * May block (heartbeating) while throttling ahead of the playback cursor.
   */
  onBeforeSegment?: (planOrdinal: number) => Promise<'continue' | 'stop'>;
  /** Called after a segment's audio is ready (or already was), with its plan ordinal. */
  onSegmentCompleted?: (planOrdinal: number) => Promise<void>;
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
  const nowMs = Date.now();
  const normalized = segments.map((segment) => {
    const text = normalizeSegmentText(segment.text);
    const locator = normalizeLocator(segment.locator as never);
    if (!text || !locator) return null;
    const locatorHash = locatorFingerprint(locator);
    const segmentKey = typeof segment.segmentKey === 'string' && segment.segmentKey.trim()
      ? segment.segmentKey.trim()
      : null;
    const textHash = buildTtsSegmentTextHash(text, secret);
    const locatorProjection = projectSegmentLocator(locator);
    const segmentEntryId = buildTtsSegmentEntryId({
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      segmentIndex: segment.segmentIndex,
      segmentKey,
      locatorIdentityKey: locatorProjection.locatorIdentityKey,
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
      locatorProjection,
      segmentEntryId,
      segmentId,
      segmentKey,
      textHash,
    };
  }).filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));

  if (normalized.length === 0) return;

  const existingRows = (await db
    .select({
      segmentId: ttsSegmentVariants.segmentId,
      status: ttsSegmentVariants.status,
      audioKey: ttsSegmentVariants.audioKey,
    })
    .from(ttsSegmentVariants)
    .where(and(
      eq(ttsSegmentVariants.userId, input.request.storageUserId),
      inArray(ttsSegmentVariants.segmentId, normalized.map((segment) => segment.segmentId)),
    ))) as Array<{ segmentId: string; status: string; audioKey: string | null }>;
  const existingById = new Map(existingRows.map((row) => [row.segmentId, row]));

  for (const segment of normalized) {
    // The pacing gate is the single stop/cancel point: it reads session status +
    // cursor and returns 'stop' when the session was superseded/expired (so a
    // canceled session ends gracefully here rather than throwing → 'failed').
    const planOrdinal = segment.original.segmentIndex;
    if (input.onBeforeSegment) {
      const decision = await input.onBeforeSegment(planOrdinal);
      if (decision === 'stop') break;
    }
    await db
      .insert(ttsSegmentEntries)
      .values({
        segmentEntryId: segment.segmentEntryId,
        userId: input.request.storageUserId,
        documentId: input.request.documentId,
        readerType: input.request.readerType,
        documentVersion: input.request.documentVersion,
        segmentIndex: segment.original.segmentIndex,
        segmentKey: segment.segmentKey,
        ...segment.locatorProjection,
        textHash: segment.textHash,
        textLength: segment.text.length,
        updatedAt: nowMs,
      })
      .onConflictDoUpdate({
        target: [ttsSegmentEntries.segmentEntryId, ttsSegmentEntries.userId],
        set: {
          readerType: input.request.readerType,
          documentVersion: input.request.documentVersion,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segment.segmentKey,
          ...segment.locatorProjection,
          textHash: segment.textHash,
          textLength: segment.text.length,
          updatedAt: nowMs,
        },
      });

    const existing = existingById.get(segment.segmentId);
    if (existing?.status === 'completed' && existing.audioKey) {
      await input.onSegmentCompleted?.(planOrdinal);
      continue;
    }

    const audioKey = existing?.audioKey || buildTtsSegmentAudioKey({
      storagePrefix: input.s3Prefix,
      namespace: null,
      userId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      settingsHash: input.request.settingsHash,
      segmentId: segment.segmentId,
    });

    await db
      .insert(ttsSegmentVariants)
      .values({
        segmentId: segment.segmentId,
        userId: input.request.storageUserId,
        segmentEntryId: segment.segmentEntryId,
        settingsHash: input.request.settingsHash,
        settingsJson: input.request.settingsJson,
        audioKey,
        audioFormat: 'mp3',
        status: 'generating',
        error: null,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [ttsSegmentVariants.segmentId, ttsSegmentVariants.userId],
        set: {
          segmentEntryId: segment.segmentEntryId,
          settingsHash: input.request.settingsHash,
          settingsJson: input.request.settingsJson,
          audioKey,
          audioFormat: 'mp3',
          status: 'generating',
          error: null,
          updatedAt: Date.now(),
        },
      });

    let lastError: unknown = null;
    let completed = false;
    for (let attempt = 1; attempt <= SEGMENT_MAX_ATTEMPTS; attempt += 1) {
      try {
        const audioBuffer = await generateTTSBuffer({
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
        });
        await input.putAudioObject(audioKey, audioBuffer);
        const durationMs = await probeAudioDurationMsFromBuffer(audioBuffer).catch(() => 0);
        const alignment = await runWhisperAlignmentFromAudioBuffer({
          audioBuffer: bufferToArrayBuffer(audioBuffer),
          text: segment.text,
          lang: effectiveSettings.language,
          cacheKey: `${segment.segmentId}:${audioKey}`,
        }).then((result) => {
          const first = result.alignments[0];
          return first ? { ...first, sentenceIndex: segment.original.segmentIndex } : null;
        }).catch(() => null);

        await db
          .update(ttsSegmentVariants)
          .set({
            status: 'completed',
            durationMs,
            alignmentJson: alignment ? JSON.stringify(alignment) : null,
            error: null,
            updatedAt: Date.now(),
          })
          .where(and(
            eq(ttsSegmentVariants.segmentId, segment.segmentId),
            eq(ttsSegmentVariants.userId, input.request.storageUserId),
          ));
        completed = true;
        break;
      } catch (error) {
        lastError = error;
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
    await db
      .update(ttsSegmentVariants)
      .set({
        status: 'error',
        error: lastError instanceof Error ? lastError.message : String(lastError),
        updatedAt: Date.now(),
      })
      .where(and(
        eq(ttsSegmentVariants.segmentId, segment.segmentId),
        eq(ttsSegmentVariants.userId, input.request.storageUserId),
      ));
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
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  pdfHardCapMs: number;
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
      await assertTtsPlaybackSessionActive(parsed.sessionId);
      await updateTtsPlaybackSession({
        sessionId: parsed.sessionId,
        status: 'running',
        lastError: null,
      });
      try {
        const plan = await resolveAndPersistTtsPlaybackPlan({
          request: parsed,
          storage: input.storage,
          s3Prefix: input.s3Prefix,
        });
        const { planObjectKey, plannedSegments, startOrdinal } = plan;

        await updateTtsPlaybackSession({
          sessionId: parsed.sessionId,
          status: 'running',
          planObjectKey,
          generationStartOrdinal: startOrdinal,
          cursorOrdinal: startOrdinal,
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

        // Throttle generation to a window ahead of the client's playback cursor.
        // When the cursor goes stale (client disconnected / JS suspended), keep
        // generating to the background-extent boundary so background playback
        // survives, then idle (heartbeating) until the cursor returns or the
        // session expires. `stoppedEarly` ⇒ we never reached the plan end, so no
        // ENDLIST.
        let stoppedEarly = false;
        let lastCompletedThrough = -1;
        let lastHeartbeatAt = 0;
        const heartbeat = async (): Promise<void> => {
          const now = Date.now();
          if (now - lastHeartbeatAt < TTS_PLAYBACK_HEARTBEAT_MS) return;
          lastHeartbeatAt = now;
          await hooks?.onProgress?.({ completedThroughOrdinal: lastCompletedThrough, plannedCount });
        };

        const onBeforeSegment = async (planOrdinal: number): Promise<'continue' | 'stop'> => {
          for (;;) {
            const cursor = await readTtsPlaybackSessionCursor(parsed.sessionId);
            if (!cursor || (cursor.status !== 'queued' && cursor.status !== 'running')) {
              stoppedEarly = true;
              return 'stop';
            }
            const now = Date.now();
            if (now > cursor.expiresAt) {
              stoppedEarly = true;
              return 'stop';
            }
            const fresh = cursor.cursorUpdatedAt != null
              && (now - cursor.cursorUpdatedAt) <= TTS_PLAYBACK_CURSOR_STALE_MS;
            if (fresh) {
              if (planOrdinal <= cursor.cursorOrdinal + aheadWindow) return 'continue';
            } else if (planOrdinal <= backgroundTargetFor(cursor.cursorOrdinal)) {
              return 'continue';
            }
            // Caught up (fresh) or past the background buffer (stale): wait.
            await heartbeat();
            await sleep(TTS_PLAYBACK_THROTTLE_POLL_MS);
          }
        };

        const onSegmentCompleted = async (planOrdinal: number): Promise<void> => {
          if (planOrdinal > lastCompletedThrough) lastCompletedThrough = planOrdinal;
          lastHeartbeatAt = Date.now();
          await hooks?.onProgress?.({ completedThroughOrdinal: lastCompletedThrough, plannedCount });
        };

        // Generate forward from the session's start ordinal only. Earlier ordinals
        // belong to the same shared plan but are generated by whichever session
        // started there (or on a backward seek); generating the whole prefix here
        // would waste work and delay first audio. The section/background maps above
        // still use the full plan so extent boundaries resolve correctly.
        const generationSegments = plannedSegments.filter((segment) => segment.segmentIndex >= startOrdinal);

        await generateExplicitTtsPlaybackSegments({
          request: parsed,
          s3Prefix: input.s3Prefix,
          segments: generationSegments,
          putAudioObject: (key, body) => input.storage.putObject(key, body, 'audio/mpeg'),
          onBeforeSegment,
          onSegmentCompleted,
        });

        // Only finalize (→ ENDLIST) when we generated the whole plan. On an early
        // stop the session was superseded/expired/disconnected — leave its status
        // alone so we don't clobber a `canceled` set by a newer session.
        if (!stoppedEarly) {
          await updateTtsPlaybackSession({
            sessionId: parsed.sessionId,
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
        await updateTtsPlaybackSession({
          sessionId: parsed.sessionId,
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
