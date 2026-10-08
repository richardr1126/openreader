import { getCbrSilenceSecond } from '@openreader/tts/audio-format';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isNotFound } from '../../infrastructure/storage';

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
const AUDIO_PREFETCH_BATCH = 4;

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
    const phaseStartedAt = new Map<string, number>();
    let lastProgressAt = 0;
    let previousPhase: string | null = null;
    const reportProgress = async (progress: TtsPlaybackExportProgress) => {
      const now = Date.now();
      if (progress.phase !== previousPhase) {
        if (previousPhase) input.logger?.info?.({ phase: previousPhase,
          durationMs: now - phaseStartedAt.get(previousPhase)!, plannedSegments: progress.plannedSegments,
        }, 'tts.export.phase_completed');
        phaseStartedAt.set(progress.phase, now);
      } else if (now - lastProgressAt < 500 && progress.completedSegments !== progress.plannedSegments) return;
      previousPhase = progress.phase;
      lastProgressAt = now;
      await hooks?.onProgress?.(progress);
    };
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
    const cacheEpoch = await playbackStorage.artifacts.getScopeEpoch(parsed);
    const assertCurrentSource = async () => {
      const [current, epoch] = await Promise.all([
        playbackStorage.sessions.getSession(parsed.sessionId),
        playbackStorage.artifacts.getScopeEpoch(parsed),
      ]);
      if (!current || epoch !== cacheEpoch
        || (current.generationRunId ?? null) !== (session.generationRunId ?? null)
        || current.status === 'canceled' || current.status === 'failed') {
        throw new Error('Audiobook sources were cleared or generation was replaced. Retry the export.');
      }
    };

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
    await reportProgress({ phase: 'assembling', completedSegments: 0, plannedSegments: plannedSegments.length });
    for (let index = 0; index < plannedSegments.length; index += SIDECAR_READ_BATCH) {
      await assertCurrentSource();
      const batch = plannedSegments.slice(index, index + SIDECAR_READ_BATCH);
      const sidecars = await Promise.all(batch.map((segment) => playbackStorage.artifacts.readSegmentMetadata({
        storageUserId: parsed.storageUserId,
        documentId: parsed.documentId,
        documentVersion: parsed.documentVersion,
        settingsHash: parsed.settingsHash,
        ordinal: segment.ordinal,
      })));
      batch.forEach((segment, batchIndex) => {
        if (Math.max(0, Math.floor(Number(sidecars[batchIndex]?.cacheEpoch ?? 0))) < cacheEpoch) {
          throw new Error('Audiobook source was invalidated by audio cleanup');
        }
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
      .catch((error) => { if (isNotFound(error)) return null; throw error; });
    if (
      existingMetadata?.schemaVersion === 1
      && existingMetadata.status === 'ready'
      && existingMetadata.generatedSegments === generatedSegments
      && existingMetadata.skippedSegments === skippedSegments
      && await input.storage.objectExists(existingMetadata.objectKey)
    ) {
      return { artifact: existingMetadata, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
    }

    const workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-export-'));
    // Each build owns its output key. An interrupted upload can safely remove
    // its file without deleting a replacement build's newly published audio.
    const objectKey = ttsPlaybackExportArtifactKey({
      artifactId: parsed.artifactId, storageUserId: parsed.storageUserId,
      documentId: parsed.documentId, format: parsed.format, prefix: input.s3Prefix, buildId: randomUUID(),
    });
    let committed = false;
    try {
      const inputPath = join(workDir, 'input.mp3');
      const assembledFile = await open(inputPath, 'w');
      let silenceSecond: Buffer | null = null;
      try {
        for (let index = 0; index < plannedSegments.length; index += AUDIO_PREFETCH_BATCH) {
          if (index % SIDECAR_READ_BATCH === 0) await assertCurrentSource();
          // One fixed batch is held in memory. Preserve plan order on disk even
          // when source reads finish out of order, and wait for writes before refill.
          const chunks = await Promise.all(plannedSegments.slice(index, index + AUDIO_PREFETCH_BATCH).map(async (segment) => {
            const source = sourcesByOrdinal.get(segment.ordinal);
            if (!source) throw new Error(`TTS playback export is missing a settled source for ordinal ${segment.ordinal}`);
            if (source.kind === 'audio') {
              return stripId3Tag(Buffer.from(await input.storage.readObject(source.audioKey)));
            } else {
              silenceSecond ??= stripId3Tag(Buffer.from(await getCbrSilenceSecond()));
              if (silenceSecond.length === 0) throw new Error('TTS playback export could not create skipped-segment silence');
              return silenceSecond;
            }
          }));
          for (const chunk of chunks) await assembledFile.writeFile(chunk);
          await reportProgress({
            phase: 'assembling',
            completedSegments: Math.min(index + AUDIO_PREFETCH_BATCH, plannedSegments.length),
            plannedSegments: plannedSegments.length,
            skippedSegments,
          });
        }
      } finally { await assembledFile.close(); }
      const chapters = buildExportChapters({ segments: plannedSegments, durationsByOrdinal, speed: parsed.speed });
      const needsFfmpeg = parsed.format === 'm4b' || speedNeedsTranscode(parsed.speed);
      await reportProgress({
        phase: needsFfmpeg ? 'transcoding' : 'uploading',
        completedSegments: plannedSegments.length,
        plannedSegments: plannedSegments.length,
        skippedSegments,
      });
      const outputPath = needsFfmpeg ? join(workDir, `audiobook.${parsed.format}`) : inputPath;
      if (needsFfmpeg) await runFfmpegExport({
        inputPath, outputPath, workDir,
        format: parsed.format,
        speed: parsed.speed,
        title: chapterTitle
          ? `OpenReader ${parsed.documentId.slice(0, 12)} - ${chapterTitle}`
          : `OpenReader ${parsed.documentId.slice(0, 12)}`,
        chapters,
      });
      await assertCurrentSource();
      await reportProgress({ phase: 'uploading', completedSegments: plannedSegments.length,
        plannedSegments: plannedSegments.length, skippedSegments });
      const { size: byteLength } = await stat(outputPath);
      await input.storage.putFile(objectKey, outputPath, contentTypeForExportFormat(parsed.format));
      await assertCurrentSource();
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
        byteLength,
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
      await assertCurrentSource();
      committed = true;
      if (existingMetadata && existingMetadata.objectKey !== objectKey) {
        await input.storage.deleteObject(existingMetadata.objectKey).catch((error) => {
          input.logger?.warn({ artifactId: parsed.artifactId, error: String(error) }, 'tts.export.old_output_cleanup_failed');
        });
      }
      await reportProgress({
        phase: 'uploading',
        completedSegments: plannedSegments.length,
        plannedSegments: plannedSegments.length,
        skippedSegments,
      });
      input.logger?.info?.({ phase: 'uploading', durationMs: Date.now() - phaseStartedAt.get('uploading')!,
        byteLength, plannedSegments: plannedSegments.length,
      }, 'tts.export.phase_completed');
      return { artifact: metadata, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
    } finally {
      if (!committed) await input.storage.deleteObject(objectKey).catch(() => undefined);
      await rm(workDir, { recursive: true, force: true });
    }
  };
}
