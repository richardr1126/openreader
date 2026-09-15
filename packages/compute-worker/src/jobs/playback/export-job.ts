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
import { readPersistedTtsPlaybackPlanSegments } from './plan';
import { ttsPlaybackExportArtifactRequestSchema } from './schemas';

const SKIPPED_SEGMENT_PAUSE_MS = 1_000;

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
    const existingMetadata = await input.storage.readObject(metadataKey)
      .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as TtsPlaybackExportArtifactMetadata)
      .catch(() => null);
    if (existingMetadata?.schemaVersion === 1 && existingMetadata.status === 'ready' && await input.storage.objectExists(existingMetadata.objectKey).catch(() => false)) {
      return { artifact: existingMetadata, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
    }

    const session = await playbackStorage.sessions.getSession(parsed.sessionId);
    if (!session) throw new Error('TTS playback export session was not found');
    if (session.storageUserId !== parsed.storageUserId || session.documentId !== parsed.documentId) {
      throw new Error('TTS playback export session scope mismatch');
    }
    if (session.status !== 'succeeded') throw new Error(`TTS playback export session is not complete: ${session.status}`);
    if (session.planObjectKey !== parsed.planObjectKey) throw new Error('TTS playback export session plan key mismatch');

    const plannedSegments = await readPersistedTtsPlaybackPlanSegments(input.storage, parsed.planObjectKey);
    if (!plannedSegments || plannedSegments.length === 0) {
      throw new Error('TTS playback export requires a loaded canonical plan');
    }
    const durationsByOrdinal = new Map<number, number>();
    const sourcesByOrdinal = new Map<number, TtsPlaybackExportSegmentSource>();
    let generatedSegments = 0;
    let skippedSegments = 0;
    for (const segment of plannedSegments) {
      const sidecar = await playbackStorage.artifacts.readSegmentMetadata({
        storageUserId: parsed.storageUserId,
        documentId: parsed.documentId,
        documentVersion: parsed.documentVersion,
        settingsHash: parsed.settingsHash,
        ordinal: segment.ordinal,
      });
      const source = resolveTtsPlaybackExportSegmentSource(segment.ordinal, sidecar);
      sourcesByOrdinal.set(segment.ordinal, source);
      durationsByOrdinal.set(segment.ordinal, source.durationMs);
      if (source.kind === 'audio') generatedSegments += 1;
      else skippedSegments += 1;
    }
    if (generatedSegments === 0) {
      throw new Error('TTS playback export could not generate any narratable audio');
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
      title: `OpenReader ${parsed.documentId.slice(0, 12)}`,
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
      dispositionFilename: buildExportFilename({ documentId: parsed.documentId, speed: parsed.speed, format: parsed.format }),
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
