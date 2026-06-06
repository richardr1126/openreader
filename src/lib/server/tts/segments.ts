import { createHash, createHmac } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { preprocessSentenceForAudio } from '@/lib/shared/nlp';
import { normalizeUnicodeToken, segmentWords } from '@/lib/shared/language';
import { locatorIdentityKey } from '@/lib/shared/tts-locator';
import { ffprobeAudio } from '@/lib/server/audiobooks/chapters';
import type {
  TTSSegmentLocator,
  TTSSegmentSettings,
} from '@/types/client';
import type { TTSSentenceAlignment, TTSSentenceWord } from '@/types/tts';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function settingsCanonical(settings: TTSSegmentSettings): string {
  return stableStringify({
    providerRef: settings.providerRef,
    providerType: settings.providerType,
    model: settings.ttsModel,
    voice: settings.voice,
    speed: Number.isFinite(Number(settings.nativeSpeed)) ? Number(settings.nativeSpeed) : 1,
    instructions: settings.ttsInstructions || '',
    language: settings.language || 'en',
    format: 'mp3',
  });
}

export function buildTtsSegmentSettingsHash(settings: TTSSegmentSettings): string {
  return createHash('sha256').update(settingsCanonical(settings)).digest('hex');
}

export function buildTtsSegmentSettingsJson(settings: TTSSegmentSettings): TTSSegmentSettings | string {
  const canonical: TTSSegmentSettings = {
    providerRef: settings.providerRef,
    providerType: settings.providerType,
    ttsModel: settings.ttsModel,
    voice: settings.voice,
    nativeSpeed: Number.isFinite(Number(settings.nativeSpeed)) ? Number(settings.nativeSpeed) : 1,
    ttsInstructions: settings.ttsInstructions || '',
    language: settings.language || 'en',
  };
  // Postgres jsonb accepts the object directly; SQLite text needs a canonical JSON string.
  return process.env.POSTGRES_URL ? canonical : settingsCanonical(settings);
}

export function normalizeSegmentText(text: string): string {
  return preprocessSentenceForAudio(text || '').trim();
}

export type TTSSegmentLocatorProjection = {
  locatorReaderRank: number;
  locatorReaderType: string;
  locatorPage: number;
  locatorSpineIndex: number;
  locatorSpineHref: string;
  locatorCharOffset: number;
  locatorLocation: string;
  locatorIdentityKey: string;
};

/**
 * Validate and shape a locator for persistence. EPUB locators MUST carry the
 * stable spine coordinates (`spineHref`, `spineIndex`, `charOffset`) — the
 * legacy CFI-only shape is rejected (returns null) so we never store a
 * viewport-dependent locator. PDF and HTML branches are unchanged.
 */
export function normalizeLocator(locator: TTSSegmentLocator | undefined): TTSSegmentLocator | null {
  if (!locator) return null;
  if (locator.readerType === 'pdf') {
    if (typeof locator.page !== 'number' || !Number.isFinite(locator.page)) return null;
    return {
      readerType: 'pdf',
      page: Math.max(1, Math.floor(locator.page)),
      ...(typeof locator.blockId === 'string' && locator.blockId.trim()
        ? { blockId: locator.blockId.trim() }
        : {}),
    };
  }
  if (locator.readerType === 'html') {
    if (typeof locator.location !== 'string' || !locator.location.trim()) return null;
    return {
      readerType: 'html',
      location: locator.location.trim(),
    };
  }
  if (locator.readerType === 'epub') {
    const spineHref = typeof locator.spineHref === 'string' ? locator.spineHref.trim() : '';
    const spineIndex = typeof locator.spineIndex === 'number' && Number.isFinite(locator.spineIndex)
      ? Math.max(0, Math.floor(locator.spineIndex))
      : -1;
    const charOffset = typeof locator.charOffset === 'number' && Number.isFinite(locator.charOffset)
      ? Math.max(0, Math.floor(locator.charOffset))
      : -1;
    if (!spineHref || spineIndex < 0 || charOffset < 0) {
      // Reject draft/legacy EPUB locators that lack stable coordinates. The
      // client is expected to resolve these via the spine-coordinates helper
      // before posting.
      return null;
    }
    const normalized: TTSSegmentLocator = {
      readerType: 'epub',
      spineHref,
      spineIndex,
      charOffset,
    };
    if (typeof locator.cfi === 'string' && locator.cfi.trim()) {
      normalized.cfi = locator.cfi.trim();
    }
    return normalized;
  }
  return null;
}

export function projectSegmentLocator(locator: TTSSegmentLocator): TTSSegmentLocatorProjection {
  if (locator.readerType === 'epub') {
    return {
      locatorReaderRank: 0,
      locatorReaderType: 'epub',
      locatorPage: -1,
      locatorSpineIndex: typeof locator.spineIndex === 'number' ? locator.spineIndex : -1,
      locatorSpineHref: typeof locator.spineHref === 'string' ? locator.spineHref : '',
      locatorCharOffset: typeof locator.charOffset === 'number' ? locator.charOffset : -1,
      locatorLocation: '',
      locatorIdentityKey: locatorIdentityKey(locator),
    };
  }
  if (locator.readerType === 'pdf') {
    return {
      locatorReaderRank: 1,
      locatorReaderType: 'pdf',
      locatorPage: typeof locator.page === 'number' ? Math.floor(locator.page) : -1,
      locatorSpineIndex: -1,
      locatorSpineHref: '',
      locatorCharOffset: -1,
      locatorLocation: '',
      locatorIdentityKey: locatorIdentityKey(locator),
    };
  }
  if (locator.readerType === 'html') {
    return {
      locatorReaderRank: 2,
      locatorReaderType: 'html',
      locatorPage: -1,
      locatorSpineIndex: -1,
      locatorSpineHref: '',
      locatorCharOffset: -1,
      locatorLocation: typeof locator.location === 'string' ? locator.location : '',
      locatorIdentityKey: locatorIdentityKey(locator),
    };
  }
  throw new Error(`Unsupported segment locator readerType for projection: ${String(locator.readerType)}`);
}

export function locatorFingerprint(locator: TTSSegmentLocator | null): string {
  if (!locator) return '';
  return createHash('sha256').update(stableStringify(locator)).digest('hex');
}

export function buildTtsSegmentId(input: {
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  segmentIndex: number;
  segmentKey?: string | null;
  normalizedText: string;
  locatorFingerprint: string;
}): string {
  const canonical = stableStringify({
    d: input.documentId,
    v: input.documentVersion,
    s: input.settingsHash,
    k: input.segmentKey || null,
    i: input.segmentKey ? null : input.segmentIndex,
    t: input.normalizedText,
    l: input.segmentKey ? null : input.locatorFingerprint,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildTtsSegmentEntryId(input: {
  documentId: string;
  documentVersion: number;
  segmentIndex: number;
  segmentKey?: string | null;
  locatorIdentityKey: string;
  textHash: string;
}): string {
  const canonical = stableStringify({
    d: input.documentId,
    v: input.documentVersion,
    i: input.segmentIndex,
    k: input.segmentKey ? input.segmentKey : null,
    l: input.locatorIdentityKey,
    t: input.textHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildTtsSegmentTextHash(text: string, secret: string): string {
  return createHmac('sha256', secret).update(text).digest('hex');
}

export function buildTtsSegmentAudioKey(input: {
  storagePrefix: string;
  namespace: string | null;
  userId: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  segmentId: string;
}): string {
  const nsSegment = input.namespace ? `ns/${input.namespace}/` : '';
  return `${input.storagePrefix}/tts_segments_v2/${nsSegment}users/${encodeURIComponent(input.userId)}/docs/${input.documentId}/${input.documentVersion}/${input.settingsHash}/${input.segmentId}.mp3`;
}

export function buildTtsSegmentDocumentPrefix(input: {
  storagePrefix: string;
  namespace: string | null;
  userId: string;
  documentId: string;
  storageVersion?: 'v1' | 'v2';
}): string {
  const nsSegment = input.namespace ? `ns/${input.namespace}/` : '';
  return `${input.storagePrefix}/tts_segments_${input.storageVersion ?? 'v2'}/${nsSegment}users/${encodeURIComponent(input.userId)}/docs/${input.documentId}/`;
}

export async function probeAudioDurationMsFromBuffer(buffer: Buffer, signal?: AbortSignal): Promise<number> {
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), 'openreader-tts-segment-'));
    const audioPath = join(workDir, 'segment.mp3');
    await writeFile(audioPath, buffer);
    const probe = await ffprobeAudio(audioPath, signal);
    const sec = Number(probe.durationSec ?? 0);
    if (!Number.isFinite(sec) || sec <= 0) {
      return 0;
    }
    return Math.max(0, Math.floor(sec * 1000));
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function alignWordsToText(
  sentence: string,
  language?: string,
): Array<{ text: string; charStart: number; charEnd: number }> {
  return segmentWords(sentence, language).map((token) => ({
    text: token.text,
    charStart: token.start,
    charEnd: token.end,
  }));
}

export function buildProportionalAlignment(input: {
  sentence: string;
  sentenceIndex: number;
  durationMs: number;
  language?: string;
}): TTSSentenceAlignment {
  const wordsWithOffsets = alignWordsToText(input.sentence, input.language);
  if (wordsWithOffsets.length === 0 || input.durationMs <= 0) {
    return {
      sentence: input.sentence,
      sentenceIndex: input.sentenceIndex,
      words: [],
    };
  }

  const weighted = wordsWithOffsets.map((word) => ({
    ...word,
    weight: Math.max(1, normalizeUnicodeToken(word.text).length),
  }));
  const totalWeight = weighted.reduce((sum, word) => sum + word.weight, 0);

  let consumedMs = 0;
  const alignedWords: TTSSentenceWord[] = weighted.map((word, index) => {
    const remainingMs = Math.max(0, input.durationMs - consumedMs);
    const sliceMs = index === weighted.length - 1
      ? remainingMs
      : Math.max(1, Math.round((input.durationMs * word.weight) / Math.max(1, totalWeight)));

    const startMs = consumedMs;
    consumedMs += Math.min(sliceMs, remainingMs);

    return {
      text: word.text,
      startSec: startMs / 1000,
      endSec: consumedMs / 1000,
      charStart: word.charStart,
      charEnd: word.charEnd,
    };
  });

  return {
    sentence: input.sentence,
    sentenceIndex: input.sentenceIndex,
    words: alignedWords,
  };
}
