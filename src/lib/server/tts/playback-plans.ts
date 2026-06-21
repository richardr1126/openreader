import { and, eq, gt } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { db } from '@openreader/database';
import { ttsSegmentEntries, ttsSegmentVariants } from '@openreader/database/schema';
import {
  buildPlaybackCbrLayout,
  estimateMsPerCharForNativeSpeed,
  type PlanSlotInput,
} from '@openreader/tts/playback-cbr-layout';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import type { ComputeOperation, TtsPlaybackPlanResult } from '@/lib/server/compute-worker/protocol';
import { getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';
import type { TTSSegmentLocator } from '@/types/client';

export type TtsPlaybackPlanArtifactSegment = {
  segmentIndex: number;
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

export async function resolveTtsPlaybackPlanOperation(planId: string): Promise<ComputeOperation<TtsPlaybackPlanResult> | null> {
  const op = await getComputeWorkerClient().getOperation<TtsPlaybackPlanResult>(planId);
  if (!op || op.subject.kind !== 'tts_playback_plan') return null;
  return op;
}

export async function readTtsPlaybackPlanArtifact(planObjectKey: string): Promise<{
  artifact: TtsPlaybackPlanArtifact;
  body: string;
}> {
  const cfg = getS3Config();
  const result = await getS3ProxyClient().send(new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: planObjectKey,
  }));
  const body = await result.Body?.transformToString();
  if (!body) throw new Error('TTS playback plan artifact is empty');
  const parsed = JSON.parse(body) as Partial<TtsPlaybackPlanArtifact> & { segments?: unknown[] };
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments.map((item): TtsPlaybackPlanArtifactSegment | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const segmentIndex = Number(row.segmentIndex);
      const text = typeof row.text === 'string' ? row.text : '';
      if (!Number.isFinite(segmentIndex) || !text.trim()) return null;
      return {
        segmentIndex: Math.max(0, Math.floor(segmentIndex)),
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

export async function listCompletedDurationsForPlan(input: {
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
}): Promise<Map<number, number>> {
  const rows = (await db
    .select({
      ordinal: ttsSegmentEntries.segmentIndex,
      durationMs: ttsSegmentVariants.durationMs,
    })
    .from(ttsSegmentEntries)
    .innerJoin(ttsSegmentVariants, and(
      eq(ttsSegmentVariants.segmentEntryId, ttsSegmentEntries.segmentEntryId),
      eq(ttsSegmentVariants.userId, ttsSegmentEntries.userId),
    ))
    .where(and(
      eq(ttsSegmentEntries.userId, input.storageUserId),
      eq(ttsSegmentEntries.documentId, input.documentId),
      eq(ttsSegmentEntries.documentVersion, input.documentVersion),
      eq(ttsSegmentVariants.settingsHash, input.settingsHash),
      eq(ttsSegmentVariants.status, 'completed'),
      gt(ttsSegmentVariants.audioKey, ''),
    ))) as Array<{ ordinal: number; durationMs: number | null }>;
  const map = new Map<number, number>();
  for (const row of rows) {
    map.set(Number(row.ordinal), Math.max(1, Number(row.durationMs ?? 1000)));
  }
  return map;
}

export function buildSeekLayout(input: {
  artifact: TtsPlaybackPlanArtifact;
  settingsJson: unknown;
  completedDurations: Map<number, number>;
  startOrdinal: number;
}) {
  const nativeSpeed = (input.settingsJson as { nativeSpeed?: unknown } | null)?.nativeSpeed;
  const msPerChar = estimateMsPerCharForNativeSpeed(nativeSpeed);
  // Real durations where a segment has been generated (so the scrubber/timeline
  // match the gapless real audio and live highlighting stays accurate), estimate
  // for the not-yet-generated tail.
  const slots: PlanSlotInput[] = input.artifact.segments.map((segment) => ({
    segmentIndex: segment.segmentIndex,
    segmentKey: segment.segmentKey,
    locator: segment.locator,
    text: segment.text,
    durationMs: input.completedDurations.get(segment.segmentIndex) ?? null,
  }));
  return buildPlaybackCbrLayout(slots, input.startOrdinal, msPerChar);
}
