import type { TtsPlaybackExportArtifactMetadata, TtsPlaybackExportArtifactRequest, TtsPlaybackExportArtifactResult, TtsPlaybackExportProgress } from '../../operations/contracts';
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
    const audioKeysByOrdinal = new Map<number, string>();
    for (const segment of plannedSegments) {
      const sidecar = await playbackStorage.artifacts.readSegmentMetadata({
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
      chunks.push(stripId3Tag(Buffer.from(await input.storage.readObject(audioKey))));
      await hooks?.onProgress?.({ phase: 'assembling', completedSegments: index + 1, plannedSegments: plannedSegments.length });
    }
    const baseMp3 = Buffer.concat(chunks);
    const chapters = buildExportChapters({ segments: plannedSegments, durationsByOrdinal, speed: parsed.speed });
    const needsFfmpeg = parsed.format === 'm4b' || speedNeedsTranscode(parsed.speed);
    await hooks?.onProgress?.({
      phase: needsFfmpeg ? 'transcoding' : 'uploading',
      completedSegments: plannedSegments.length,
      plannedSegments: plannedSegments.length,
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
      dispositionFilename: buildExportFilename({ documentId: parsed.documentId, speed: parsed.speed, format: parsed.format }),
      sourceSessionId: parsed.sessionId,
      sourcePlanObjectKey: parsed.planObjectKey,
      status: 'ready',
      createdAt: Date.now(),
    };
    await input.storage.putObject(metadataKey, Buffer.from(JSON.stringify(metadata)), 'application/json');
    await hooks?.onProgress?.({ phase: 'uploading', completedSegments: plannedSegments.length, plannedSegments: plannedSegments.length });
    return { artifact: metadata, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
  };
}
