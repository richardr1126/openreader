import { createHash } from 'node:crypto';
import { buildTtsPlaybackSegmentAudioKey } from '@openreader/tts/segments';
import type { ArtifactStorage } from '../infrastructure/storage';
import {
  sidecarDescribesSegment,
  type TtsPlaybackSegmentMetadata,
  type TtsPlaybackSegmentScope,
  type TtsPlaybackStorage,
} from './storage';

const SIDECAR_READ_BATCH = 32;

export interface PlanRepairResult {
  relinked: number;
  removedSidecars: number;
  deletedAudio: number;
  canceledSessions: number;
}

/**
 * Sidecars are addressed by plan ordinal, so after a PDF reparse the earlier
 * layout's records sit at positions the new plan gives other passages. Reads
 * already refuse them; this pass, run once per plan and settings scope, puts
 * the scope in order for the new plan:
 *
 * - sessions still on an earlier plan stop, so they cannot write its records back;
 * - audio of passages the new plan no longer has is deleted;
 * - a passage that moved gets its existing record (audio, duration and word
 *   timing) at its new position, with no synthesis or alignment;
 * - every other record of an earlier plan is removed.
 *
 * Audio goes first: if its deletion fails, no record has been touched and the
 * next run can still find it. Finished audiobook files are standalone and stay.
 */
export async function repairSegmentsForPlan(input: {
  storage: ArtifactStorage;
  playbackStorage: TtsPlaybackStorage;
  s3Prefix: string;
  scope: TtsPlaybackSegmentScope;
  planObjectKey: string;
  plannedSegments: Array<{ ordinal: number; segmentKey?: string | null }>;
  /** Deletes audio inside the storage-usage fence. */
  clearAudio: <T>(run: () => Promise<T>) => Promise<T>;
  /**
   * Whether this plan is still the document's layout. Checked again after the
   * snapshot, so a repair overtaken by another reparse changes nothing.
   */
  planIsCurrent: () => Promise<boolean>;
  now?: number;
}): Promise<PlanRepairResult | null> {
  const { storage, playbackStorage, scope, planObjectKey } = input;
  const artifacts = playbackStorage.artifacts;
  const markerKey = planRepairMarkerKey(artifacts.sidecarKey({ ...scope, ordinal: 0 }), planObjectKey);
  if (await storage.objectExists(markerKey)) return null;
  const now = input.now ?? Date.now();

  const ordinals = await artifacts.listSegmentOrdinals(scope);
  const sidecars = new Map<number, TtsPlaybackSegmentMetadata>();
  for (let index = 0; index < ordinals.length; index += SIDECAR_READ_BATCH) {
    const batch = ordinals.slice(index, index + SIDECAR_READ_BATCH);
    const read = await Promise.all(batch.map((ordinal) => artifacts.readSegmentMetadata({ ...scope, ordinal, segmentKey: null })));
    read.forEach((sidecar, batchIndex) => { if (sidecar) sidecars.set(batch[batchIndex]!, sidecar); });
  }

  const planned = new Map(input.plannedSegments.map((segment) => [segment.ordinal, segment.segmentKey ?? null]));
  const plannedKeys = new Set([...planned.values()].filter((key): key is string => Boolean(key)));
  const completedByKey = new Map<string, TtsPlaybackSegmentMetadata>();
  for (const sidecar of sidecars.values()) {
    if (sidecar.status === 'completed' && sidecar.audioKey && sidecar.segmentKey && !completedByKey.has(sidecar.segmentKey)) {
      completedByKey.set(sidecar.segmentKey, sidecar);
    }
  }

  const relinks: TtsPlaybackSegmentMetadata[] = [];
  const removals: number[] = [];
  for (const ordinal of sidecars.keys()) {
    if (!planned.has(ordinal)) removals.push(ordinal);
  }
  for (const [ordinal, segmentKey] of planned) {
    const current = sidecars.get(ordinal);
    if (current && sidecarDescribesSegment(current, segmentKey)) continue;
    const source = segmentKey ? completedByKey.get(segmentKey) : undefined;
    if (source) {
      relinks.push({
        ...source,
        ordinal,
        alignment: source.alignment ? { ...source.alignment, sentenceIndex: ordinal } : null,
        updatedAt: now,
      });
    } else if (current) {
      removals.push(ordinal);
    }
  }

  // Only this scope's own audio, and only passages the new plan does not speak.
  const audioPrefix = buildTtsPlaybackSegmentAudioKey({
    storagePrefix: input.s3Prefix,
    namespace: null,
    userId: scope.storageUserId,
    documentId: scope.documentId,
    documentVersion: scope.documentVersion,
    settingsHash: scope.settingsHash,
    audioContentHash: '',
  }).slice(0, -'.mp3'.length);
  const unusedAudio = [...new Set([...sidecars.values()]
    .filter((sidecar) => sidecar.segmentKey && !plannedKeys.has(sidecar.segmentKey))
    .map((sidecar) => sidecar.audioKey)
    .filter((key) => key?.startsWith(audioPrefix)))];
  if (!await input.planIsCurrent()) return null;

  let canceledSessions = 0;
  for (const session of await playbackStorage.sessions.listSessions(scope)) {
    if (session.planObjectKey === planObjectKey || (session.status !== 'queued' && session.status !== 'running')) continue;
    await playbackStorage.sessions.patchSession(session.sessionId, {
      status: 'canceled',
      lastError: 'The PDF layout was reparsed',
      updatedAt: now,
    });
    canceledSessions += 1;
  }

  if (unusedAudio.length > 0) {
    await input.clearAudio(async () => {
      for (const key of unusedAudio) await storage.deleteObject(key);
    });
  }
  // Generation for this plan, or a concurrent repair, may have written a
  // record since the snapshot; only records still as snapshotted change.
  const readRaw = (ordinal: number) => artifacts.readSegmentMetadata({ ...scope, ordinal, segmentKey: null });
  let relinked = 0;
  for (const sidecar of relinks) {
    const fresh = await readRaw(sidecar.ordinal);
    if (fresh && sidecarDescribesSegment(fresh, sidecar.segmentKey)) continue;
    await artifacts.putSegmentMetadata(sidecar);
    relinked += 1;
  }
  let removedSidecars = 0;
  for (const ordinal of removals) {
    const snapshot = sidecars.get(ordinal);
    const fresh = await readRaw(ordinal);
    if (!fresh || !snapshot || fresh.segmentKey !== snapshot.segmentKey || fresh.updatedAt !== snapshot.updatedAt) continue;
    await storage.deleteObject(artifacts.sidecarKey({ ...scope, ordinal }));
    removedSidecars += 1;
  }

  await storage.putObject(markerKey, Buffer.from(JSON.stringify({ schemaVersion: 1, planObjectKey, repairedAt: now })), 'application/json');
  return {
    relinked,
    removedSidecars,
    deletedAudio: unusedAudio.length,
    canceledSessions,
  };
}

/** Beside the scope's `segments/`, so ordinal listing never sees it and clearing the scope removes it. */
function planRepairMarkerKey(firstSidecarKey: string, planObjectKey: string): string {
  const scopePrefix = firstSidecarKey.slice(0, -'segments/0.json'.length);
  return `${scopePrefix}plan-repairs/${createHash('sha256').update(planObjectKey).digest('hex').slice(0, 32)}.json`;
}
