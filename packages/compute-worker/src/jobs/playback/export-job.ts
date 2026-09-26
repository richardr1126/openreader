import { getCbrSilenceSecond } from '@openreader/tts/audio-format';

import type { TtsPlaybackExportArtifactMetadata, TtsPlaybackExportArtifactRequest, TtsPlaybackExportArtifactResult, TtsPlaybackExportProgress } from '../../operations/contracts';
import type { TtsPlaybackSegmentMetadata } from '../../playback/storage';
import { ttsPlaybackExportArtifactKey, ttsPlaybackExportMetadataArtifactKey } from '../../storage/artifact-addressing';
import type { JobHandlerContext } from '../context';
import {
  buildExportChapters,
  buildExportFilename,
  contentTypeForExportFormat,
  runFfmpegExport,
  speedNeedsTranscode,
  stripId3Tag,
} from './ffmpeg-export';
import { groupExportChapters } from './export-chapters';
import { readPersistedTtsPlaybackPlanSegments } from './plan';
import { ttsPlaybackExportArtifactRequestSchema } from './schemas';

const SKIPPED_SEGMENT_PAUSE_MS = 1_000;
const SIDECAR_READ_BATCH = 32;

export type TtsPlaybackExportSegmentSource =
  | { kind: 'audio'; audioKey: string; durationMs: number }
  | { kind: 'silence'; durationMs: number };

export function resolveTtsPlaybackExportSegmentSource(
  ordinal: number,
  sidecar: TtsPlaybackSegmentMetadata | null,
): TtsPlaybackExportSegmentSource {
  if (sidecar?.status === 'completed' && sidecar.audioKey) {
    return {
      kind: 'audio',
      audioKey: sidecar.audioKey,
      durationMs: Math.max(1, Number(sidecar.durationMs ?? 1_000)),
    };
  }
  if (sidecar?.status === 'error') {
    return { kind: 'silence', durationMs: SKIPPED_SEGMENT_PAUSE_MS };
  }
  throw new Error(`TTS playback export segment ${ordinal} is not durably settled`);
}

export function createTtsPlaybackExportHandler(input: JobHandlerContext) {
  return async function runTtsPlaybackExportArtifact(
    payload: TtsPlaybackExportArtifactRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: TtsPlaybackExportProgress) => Promise<void> },
  ): Promise<TtsPlaybackExportArtifactResult> {
    const parsed = ttsPlaybackExportArtifactRequestSchema.parse(payload);
    const startedAt = Date.now();
    if (!input.playbackStorage) throw new Error('TTS playback storage is required');
    const playbackStorage = input.playbackStorage;
    const metadataKey = ttsPlaybackExportMetadataArtifactKey({
      artifactId: parsed.artifactId,
      storageUserId: parsed.storageUserId,
      documentId: parsed.documentId,
      prefix: input.s3Prefix,
    });
    const session = await playbackStorage.sessions.getSession(parsed.sessionId);
    if (!session) throw new Error('TTS playback export session was not found');
    if (session.storageUserId !== parsed.storageUserId || session.documentId !== parsed.documentId) {
      throw new Error('TTS playback export session scope mismatch');
    }
    if (session.planObjectKey !== parsed.planObjectKey) throw new Error('TTS playback export session plan key mismatch');
    // A whole-book artifact needs a finished run. One chapter only needs its
    // own segments settled, so it can be downloaded while later chapters are
    // still generating or after a stopped/limited run.
    if (parsed.chapterIndex === undefined && (session.status !== 'succeeded' || session.stopReason)) {
      throw new Error(`TTS playback export session is not complete: ${session.stopReason ?? session.status}`);
    }

    const documentSegments = await readPersistedTtsPlaybackPlanSegments(input.storage, parsed.planObjectKey);
    if (!documentSegments || documentSegments.length === 0) {
      throw new Error('TTS playback export requires a loaded canonical plan');
    }
    let plannedSegments = documentSegments;
    let chapterTitle: string | null = null;
    if (parsed.chapterIndex !== undefined) {
      const chapter = groupExportChapters(documentSegments)[parsed.chapterIndex];
      if (!chapter) throw new Error(`TTS playback export chapter ${parsed.chapterIndex} does not exist`);
      const ordinals = new Set(chapter.ordinals);
      plannedSegments = documentSegments.filter((segment) => ordinals.has(segment.ordinal));
      chapterTitle = chapter.title;
    }
    const durationsByOrdinal = new Map<number, number>();
    const sourcesByOrdinal = new Map<number, TtsPlaybackExportSegmentSource>();
    let generatedSegments = 0;
    let skippedSegments = 0;
    for (let index = 0; index < plannedSegments.length; index += SIDECAR_READ_BATCH) {
      const batch = plannedSegments.slice(index, index + SIDECAR_READ_BATCH);
      const sidecars = await Promise.all(batch.map((segment) => playbackStorage.artifacts.readSegmentMetadata({
        storageUserId: parsed.storageUserId,
        documentId: parsed.documentId,
        documentVersion: parsed.documentVersion,
        settingsHash: parsed.settingsHash,
        ordinal: segment.ordinal,
      })));
      batch.forEach((segment, batchIndex) => {
        const source = resolveTtsPlaybackExportSegmentSource(segment.ordinal, sidecars[batchIndex] ?? null);
        sourcesByOrdinal.set(segment.ordinal, source);
        durationsByOrdinal.set(segment.ordinal, source.durationMs);
        if (source.kind === 'audio') generatedSegments += 1;
        else skippedSegments += 1;
      });
    }
    if (generatedSegments === 0) {
      throw new Error('TTS playback export could not generate any narratable audio');
    }

    // Artifact ids are deterministic per scope, so a ready artifact is reused
    // only while it still describes the current sidecars. Retrying skipped
    // segments changes the counts and rebuilds the file without its silence.
    const existingMetadata = await input.storage.readObject(metadataKey)
      .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as TtsPlaybackExportArtifactMetadata)
      .catch(() => null);
    if (
      existingMetadata?.schemaVersion === 1
      && existingMetadata.status === 'ready'
      && existingMetadata.generatedSegments === generatedSegments
      && existingMetadata.skippedSegments === skippedSegments
      && await input.storage.objectExists(existingMetadata.objectKey).catch(() => false)
    ) {
      return { artifact: existingMetadata, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
    }

    const chunks: Buffer[] = [];
    let silenceSecond: Buffer | null = null;
    for (let index = 0; index < plannedSegments.length; index += 1) {
      const segment = plannedSegments[index]!;
      const source = sourcesByOrdinal.get(segment.ordinal);
      if (!source) throw new Error(`TTS playback export is missing a settled source for ordinal ${segment.ordinal}`);
      if (source.kind === 'audio') {
        chunks.push(stripId3Tag(Buffer.from(await input.storage.readObject(source.audioKey))));
      } else {
        silenceSecond ??= stripId3Tag(Buffer.from(await getCbrSilenceSecond()));
        if (silenceSecond.length === 0) throw new Error('TTS playback export could not create skipped-segment silence');
        chunks.push(silenceSecond);
      }
      await hooks?.onProgress?.({
        phase: 'assembling',
        completedSegments: index + 1,
        plannedSegments: plannedSegments.length,
        skippedSegments,
      });
    }
    const baseMp3 = Buffer.concat(chunks);
    const chapters = buildExportChapters({ segments: plannedSegments, durationsByOrdinal, speed: parsed.speed });
    const needsFfmpeg = parsed.format === 'm4b' || speedNeedsTranscode(parsed.speed);
    await hooks?.onProgress?.({
      phase: needsFfmpeg ? 'transcoding' : 'uploading',
      completedSegments: plannedSegments.length,
      plannedSegments: plannedSegments.length,
      skippedSegments,
    });
    const output = needsFfmpeg ? await runFfmpegExport({
      source: baseMp3,
      format: parsed.format,
      speed: parsed.speed,
      title: chapterTitle
        ? `OpenReader ${parsed.documentId.slice(0, 12)} - ${chapterTitle}`
        : `OpenReader ${parsed.documentId.slice(0, 12)}`,
      chapters,
    }) : baseMp3;
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
      generatedSegments,
      skippedSegments,
      plannedSegments: plannedSegments.length,
      ...(parsed.chapterIndex === undefined ? {} : { chapterIndex: parsed.chapterIndex }),
      dispositionFilename: buildExportFilename({
        documentId: parsed.documentId,
        speed: parsed.speed,
        format: parsed.format,
        ...(parsed.chapterIndex === undefined ? {} : { chapterIndex: parsed.chapterIndex }),
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
      skippedSegments,
    });
    return { artifact: metadata, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
  };
}
