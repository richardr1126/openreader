import { createHash, createHmac } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { preprocessSentenceForAudio } from '@/lib/shared/nlp';
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
    provider: settings.ttsProvider,
    model: settings.ttsModel,
    voice: settings.voice,
    speed: Number.isFinite(Number(settings.nativeSpeed)) ? Number(settings.nativeSpeed) : 1,
    instructions: settings.ttsInstructions || '',
    format: 'mp3',
  });
}

export function buildTtsSegmentSettingsHash(settings: TTSSegmentSettings): string {
  return createHash('sha256').update(settingsCanonical(settings)).digest('hex');
}

export function buildTtsSegmentSettingsJson(settings: TTSSegmentSettings): TTSSegmentSettings | string {
  const canonical: TTSSegmentSettings = {
    ttsProvider: settings.ttsProvider,
    ttsModel: settings.ttsModel,
    voice: settings.voice,
    nativeSpeed: Number.isFinite(Number(settings.nativeSpeed)) ? Number(settings.nativeSpeed) : 1,
    ttsInstructions: settings.ttsInstructions || '',
  };
  // Postgres jsonb accepts the object directly; SQLite text needs a canonical JSON string.
  return process.env.POSTGRES_URL ? canonical : settingsCanonical(settings);
}

export function normalizeSegmentText(text: string): string {
  return preprocessSentenceForAudio(text || '').trim();
}

export function normalizeLocator(locator: TTSSegmentLocator | undefined): TTSSegmentLocator | null {
  if (!locator) return null;
  const normalized: TTSSegmentLocator = {};
  if (typeof locator.page === 'number' && Number.isFinite(locator.page)) {
    normalized.page = Math.max(1, Math.floor(locator.page));
  }
  if (typeof locator.location === 'string' && locator.location.trim()) {
    normalized.location = locator.location.trim();
  }
  if (locator.readerType === 'pdf' || locator.readerType === 'epub' || locator.readerType === 'html') {
    normalized.readerType = locator.readerType;
  }
  if (Object.keys(normalized).length === 0) return null;
  return normalized;
}

export function locatorFingerprint(locator: TTSSegmentLocator | null): string {
  if (!locator) return '';
  return createHash('sha256').update(stableStringify(locator)).digest('hex');
}

export function canonicalLocatorJson(locator: TTSSegmentLocator | null | undefined): string | null {
  if (!locator) return null;
  return stableStringify(locator);
}

export function canonicalizeLocatorJsonString(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return null;
    return stableStringify(parsed);
  } catch {
    return null;
  }
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
  return `${input.storagePrefix}/tts_segments_v1/${nsSegment}users/${encodeURIComponent(input.userId)}/docs/${input.documentId}/${input.documentVersion}/${input.settingsHash}/${input.segmentId}.mp3`;
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

function alignWordsToText(sentence: string): Array<{ text: string; charStart: number; charEnd: number }> {
  const words = sentence.match(/\S+/g) || [];
  const aligned: Array<{ text: string; charStart: number; charEnd: number }> = [];
  let cursor = 0;
  const lowerSentence = sentence.toLowerCase();

  for (const token of words) {
    const clean = token.trim();
    if (!clean) continue;
    const idx = lowerSentence.indexOf(clean.toLowerCase(), cursor);
    const start = idx >= 0 ? idx : cursor;
    const end = Math.min(sentence.length, start + clean.length);
    cursor = Math.max(cursor, end);
    aligned.push({
      text: clean,
      charStart: start,
      charEnd: end,
    });
  }

  return aligned;
}

export function buildProportionalAlignment(input: {
  sentence: string;
  sentenceIndex: number;
  durationMs: number;
}): TTSSentenceAlignment {
  const wordsWithOffsets = alignWordsToText(input.sentence);
  if (wordsWithOffsets.length === 0 || input.durationMs <= 0) {
    return {
      sentence: input.sentence,
      sentenceIndex: input.sentenceIndex,
      words: [],
    };
  }

  const weighted = wordsWithOffsets.map((word) => ({
    ...word,
    weight: Math.max(1, word.text.replace(/[^a-zA-Z0-9]/g, '').length),
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
