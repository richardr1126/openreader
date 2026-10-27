import { GetObjectCommand } from '@aws-sdk/client-s3';
import { estimateAddedPauseMs } from '@openreader/tts/voice-customization';
import type { TTSSegmentSettings } from '@openreader/tts/types';
import {
  buildPlaybackCbrLayout,
  estimateMsPerCharForNativeSpeed,
  type PlanSlotInput,
} from '@openreader/tts/playback-cbr-layout';
import { MP3_FRAME_DURATION_MS } from '@openreader/tts/audio-format';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import type { ComputeOperation, TtsPlaybackPlanResult } from '@/lib/server/compute-worker/protocol';
import { getS3Config, getS3InternalClient } from '@/lib/server/storage/s3';
import type { TTSSegmentLocator } from '@/types/client';
import type { TTSSentenceAlignment } from '@/types/tts';

export type TtsPlaybackPlanArtifactSegment = {
  ordinal: number;
  segmentKey: string | null;
  text: string;
  locator: TTSSegmentLocator | null;
};

export type TtsPlaybackPlanArtifact = {
  schemaVersion: 1;
  sessionId?: string | null;
  storageUserId?: string;
  documentId: string;
  documentVersion: number;
  readerType: string;
  settingsHash: string;
  settingsJson?: unknown;
  segments: TtsPlaybackPlanArtifactSegment[];
};

function requirePlaybackSchemaVersion(value: unknown, artifactName: string): asserts value is 1 {
  if (value !== 1) {
    throw new Error(`Unsupported ${artifactName} schema version: ${String(value)}`);
  }
}

function normalizePlanOrdinal(row: Record<string, unknown>): number {
  const ordinal = Number(row.ordinal);
  if (!Number.isFinite(ordinal)) throw new Error('TTS playback plan segment requires ordinal');
  return Math.max(0, Math.floor(ordinal));
}

export async function resolveTtsPlaybackPlanOperation(planId: string): Promise<ComputeOperation<TtsPlaybackPlanResult> | null> {
  const op = await getComputeWorkerClient().getOperation<TtsPlaybackPlanResult>(planId);
  if (!op || op.subject.kind !== 'tts_playback_plan') return null;
  return op;
}

type TtsPlaybackPlanArtifactRead = {
  artifact: TtsPlaybackPlanArtifact;
  body: string;
};

// Plan artifacts are immutable per object key, and every timeline read needs
// one, so a warm instance keeps the few it is serving instead of re-fetching.
const PLAN_ARTIFACT_CACHE_LIMIT = 8;
const planArtifactCache = new Map<string, Promise<TtsPlaybackPlanArtifactRead>>();

export function readTtsPlaybackPlanArtifact(planObjectKey: string): Promise<TtsPlaybackPlanArtifactRead> {
  const cached = planArtifactCache.get(planObjectKey);
  if (cached) {
    planArtifactCache.delete(planObjectKey);
    planArtifactCache.set(planObjectKey, cached);
    return cached;
  }
  const read = fetchTtsPlaybackPlanArtifact(planObjectKey);
  planArtifactCache.set(planObjectKey, read);
  read.catch(() => {
    if (planArtifactCache.get(planObjectKey) === read) planArtifactCache.delete(planObjectKey);
  });
  while (planArtifactCache.size > PLAN_ARTIFACT_CACHE_LIMIT) {
    planArtifactCache.delete(planArtifactCache.keys().next().value!);
  }
  return read;
}

async function fetchTtsPlaybackPlanArtifact(planObjectKey: string): Promise<TtsPlaybackPlanArtifactRead> {
  const cfg = getS3Config();
  const result = await getS3InternalClient().send(new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: planObjectKey,
  }));
  const body = await result.Body?.transformToString();
  if (!body) throw new Error('TTS playback plan artifact is empty');
  const parsed = JSON.parse(body) as Partial<TtsPlaybackPlanArtifact> & { segments?: unknown[] };
  requirePlaybackSchemaVersion(parsed.schemaVersion, 'TTS playback plan');
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments.map((item): TtsPlaybackPlanArtifactSegment | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const ordinal = normalizePlanOrdinal(row);
      const text = typeof row.text === 'string' ? row.text : '';
      if (!text.trim()) return null;
      return {
        ordinal,
        segmentKey: typeof row.segmentKey === 'string' ? row.segmentKey : null,
        text,
        locator: row.locator && typeof row.locator === 'object' ? row.locator as TTSSegmentLocator : null,
      };
    }).filter((item): item is TtsPlaybackPlanArtifactSegment => Boolean(item))
    : [];
  return {
    body,
    artifact: {
      schemaVersion: 1,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      storageUserId: typeof parsed.storageUserId === 'string' ? parsed.storageUserId : undefined,
      documentId: typeof parsed.documentId === 'string' ? parsed.documentId : '',
      documentVersion: Number.isFinite(Number(parsed.documentVersion)) ? Math.max(0, Math.floor(Number(parsed.documentVersion))) : 0,
      readerType: typeof parsed.readerType === 'string' ? parsed.readerType : '',
      settingsHash: typeof parsed.settingsHash === 'string' ? parsed.settingsHash : '',
      settingsJson: parsed.settingsJson,
      segments,
    },
  };
}

export type TtsPlaybackGridSegment = {
  ordinal: number;
  segmentKey: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  audioState: 'pending' | 'ready' | 'error';
  durationSource: 'estimated' | 'exact';
  generated: boolean;
  estimated: boolean;
  locator: TTSSegmentLocator | null;
  alignment: TTSSentenceAlignment | null;
  alignmentSource: 'exact' | null;
  updatedAt?: number | null;
};

export type TtsPlaybackGrid = {
  durationMs: number;
  segments: TtsPlaybackGridSegment[];
};

export function buildPlaybackGrid(input: {
  artifact: TtsPlaybackPlanArtifact;
  settingsJson: unknown;
  completedDurations: Map<number, number>;
  startOrdinal: number;
  /** Failed sentences: the audio stream plays their estimated slot as silence. */
  erroredOrdinals?: ReadonlySet<number>;
  completedSegments?: Map<number, {
    alignment: TTSSentenceAlignment | null;
    alignmentSource: 'exact' | null;
    updatedAt?: number | null;
  }>;
}) {
  const settings = (typeof input.settingsJson === 'string'
    ? JSON.parse(input.settingsJson) : input.settingsJson) as TTSSegmentSettings | null;
  const msPerChar = estimateMsPerCharForNativeSpeed(settings?.nativeSpeed);
  // Real durations where a segment has been generated (so the scrubber/timeline
  // match the gapless real audio and live highlighting stays accurate), estimate
  // for the not-yet-generated tail.
  const slots: PlanSlotInput[] = input.artifact.segments.map((segment) => ({
    ordinal: segment.ordinal,
    segmentKey: segment.segmentKey,
    locator: segment.locator,
    text: segment.text,
    durationMs: input.completedDurations.get(segment.ordinal) ?? null,
    addedPauseMs: estimateAddedPauseMs(segment.text, settings?.voiceCustomization, settings?.providerType ?? ''),
  }));
  // Quantize silence slots to whole MP3 frames so the grid's startMs values match
  // the frame-accurate silence the worker emits (the byte map uses the same
  // quantization). The grid maps by time, never bytes, so it omits the exact
  // frame-byte resolver the worker passes.
  const layout = buildPlaybackCbrLayout(slots, input.startOrdinal, msPerChar, {
    frameDurationMs: MP3_FRAME_DURATION_MS,
  });
  return {
    durationMs: layout.durationMs,
    segments: layout.slots.map((slot): TtsPlaybackGridSegment => {
      const completed = input.completedSegments?.get(slot.ordinal) ?? null;
      return {
        ordinal: slot.ordinal,
        segmentKey: slot.segmentKey,
        startMs: slot.startMs,
        endMs: slot.endMs,
        durationMs: slot.durationMs,
        audioState: slot.generated
          ? 'ready'
          : input.erroredOrdinals?.has(slot.ordinal) ? 'error' : 'pending',
        durationSource: slot.generated ? 'exact' : 'estimated',
        generated: slot.generated,
        estimated: slot.estimated,
        locator: slot.locator as TTSSegmentLocator | null,
        alignment: completed?.alignment ?? null,
        alignmentSource: completed?.alignmentSource ?? null,
        updatedAt: completed?.updatedAt ?? null,
      };
    }),
  };
}
