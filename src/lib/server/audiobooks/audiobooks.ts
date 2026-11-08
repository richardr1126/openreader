import { createHash } from 'node:crypto';
import { and, asc, eq, lt } from 'drizzle-orm';
import {
  buildTtsPlaybackCanonicalSessionId,
  buildTtsPlaybackExportArtifactId,
} from '@openreader/tts/playback-scope';
import { db } from '@openreader/database';
import { AdvisoryLockBusyError, withPostgresAdvisoryLock } from '@openreader/database/advisory-lock';
import { audiobookRequests } from '@openreader/database/schema';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { ApiRequestError } from '@/lib/server/api/responses';
import { buildTtsPlaybackAdmissionRequestKey } from '@/lib/server/compute-limits/admission';
import type { ComputeLimitSubject } from '@/lib/server/compute-limits/policy';
import {
  ComputeAdmissionLimitedError,
  createAdmittedComputeOperation,
} from '@/lib/server/compute-limits/run-admitted';
import { ComputeWorkerClient, isComputeWorkerAvailable, isComputeWorkerUnavailableError } from '@/lib/server/compute-worker/client';
import type {
  TtsPlaybackExportProgressSummary,
  TtsPlaybackPlanResult,
} from '@/lib/server/compute-worker/protocol';
import { serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';
import { storedRecord } from '@/lib/server/reader/bootstrap';
import { createAdmittedPlaybackPlanOperation, findPlaybackPlanOperation } from '@/lib/server/reader/playback';
import {
  classifyExportArtifact,
  classifyExportGeneration,
  exportGenerationRunId,
  exportOperationIssue,
} from '@/lib/server/tts/export-state';
import {
  buildTtsPlaybackPlanningInput,
  parseTtsPlaybackRequestBody,
  type ParsedTtsPlaybackRequestBody,
} from '@/lib/server/tts/playback-request';
import { TTS_PLAYBACK_SESSION_TTL_MS } from '@/lib/server/tts/playback-sessions';
import { storageLimit } from '@/lib/server/storage/usage';
import { resolveUserDocumentScope, type ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import type { Audiobook, AudiobookStatus, TtsExportArtifactState, TtsExportGenerationState, TtsExportIssue } from '@/types/tts-export';
import { TTS_PLAYBACK_AHEAD_WINDOW } from '@/types/tts';

/** What was asked for. The playback request carries no `startIntent`: exports start at ordinal 0. */
export type AudiobookIntent = {
  format: 'mp3' | 'm4b';
  speed: number;
  chapterIndex: number | null;
  parsed: ParsedTtsPlaybackRequestBody;
  /** Reference only: terminal state stays in the worker after session expiry. */
  generationOperationId?: string;
};

export type AudiobookCaller = {
  scope: ResolvedSegmentDocumentScope;
  subject: ComputeLimitSubject;
  clientId?: string;
  /** Without it a caller only observes: no plan, generation, build or adoption. */
  mayGenerate: boolean;
};

/**
 * - read: report only; nothing has been asked for.
 * - advance: an audiobook was asked for, so start whichever step is due.
 * - start, retry-skipped, stop: a caller's explicit command.
 */
type AudiobookCommand = 'read' | 'advance' | 'start' | 'retry-skipped' | 'stop';

export class ChapterNotFoundError extends Error {
  constructor() {
    super('Chapter not found in this audiobook');
    this.name = 'ChapterNotFoundError';
  }
}

export class ChapterCommandError extends Error {
  constructor() {
    super('Chapter exports only support lookup and start.');
    this.name = 'ChapterCommandError';
  }
}

type Row = typeof audiobookRequests.$inferSelect;

// Serialize the command and its worker calls, including across formats that
// share a generation session. Postgres deployments can have many app instances;
// SQLite is served by one app process and needs no database write lock here.
const audiobookLocks = (globalThis as typeof globalThis & {
  audiobookLocks?: Map<string, Promise<void>>;
}).audiobookLocks ??= new Map<string, Promise<void>>();

async function withAudiobookLock<T>(caller: AudiobookCaller, documentId: string, run: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([caller.scope.storageUserId, documentId]);
  if (process.env.POSTGRES_URL) {
    try {
      return await withPostgresAdvisoryLock(`audiobook:${key}`, run);
    } catch (error) {
      if (!(error instanceof AdvisoryLockBusyError)) throw error;
      throw new ApiRequestError(503, 'AUDIOBOOK_BUSY', 'Another request for this audiobook is still running.', 5_000);
    }
  }
  const previous = audiobookLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  audiobookLocks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (audiobookLocks.get(key) === tail) audiobookLocks.delete(key);
  }
}

function audiobookId(caller: AudiobookCaller, intent: AudiobookIntent, settingsHash: string): string {
  return createHash('sha256')
    .update(JSON.stringify([
      caller.scope.storageUserId,
      intent.parsed.documentId,
      caller.scope.documentVersion,
      settingsHash,
      intent.format,
      intent.speed,
      intent.chapterIndex,
    ]))
    .digest('hex')
    .slice(0, 32);
}

function webUrl(path: string): string {
  return new URL(path, (process.env.BASE_URL ?? '').trim() || 'http://localhost').toString();
}

function audiobookStatus(
  generation: TtsExportGenerationState,
  artifact: TtsExportArtifactState,
): AudiobookStatus {
  if (artifact === 'ready') return 'ready';
  if (artifact === 'building') return 'building';
  if (artifact === 'waiting') return 'waiting';
  if (artifact === 'failed') return 'failed';
  return generation;
}

function toStoredRequest(intent: AudiobookIntent): string | object {
  const { parsed } = intent;
  const stored = {
    settings: parsed.settings,
    startLocation: parsed.startLocation,
    maxBlockLength: parsed.maxBlockLength,
    language: parsed.language,
    skipBlockKinds: parsed.skipBlockKinds,
    generationOperationId: intent.generationOperationId,
  };
  return process.env.POSTGRES_URL ? stored : JSON.stringify(stored);
}

function intentFromRow(row: Row): AudiobookIntent | null {
  const stored = storedRecord(row.settingsJson);
  const parsed = parseTtsPlaybackRequestBody({
    documentId: row.documentId,
    settings: stored.settings,
    startLocation: stored.startLocation,
    planning: {
      ...(stored.maxBlockLength === undefined ? {} : { maxBlockLength: stored.maxBlockLength }),
      ...(stored.language === undefined ? {} : { language: stored.language }),
      ...(stored.skipBlockKinds === undefined ? {} : { skipBlockKinds: stored.skipBlockKinds }),
    },
    ...(row.planObjectKey ? { planObjectKey: row.planObjectKey } : {}),
  });
  if (!parsed) return null;
  return {
    format: row.format === 'm4b' ? 'm4b' : 'mp3',
    speed: Number(row.speed),
    chapterIndex: row.chapterIndex,
    parsed,
    ...(typeof stored.generationOperationId === 'string' ? { generationOperationId: stored.generationOperationId } : {}),
  };
}

async function findRow(id: string, userId: string, documentId: string): Promise<Row | null> {
  const rows = await db.select().from(audiobookRequests).where(and(
    eq(audiobookRequests.id, id),
    eq(audiobookRequests.userId, userId),
    eq(audiobookRequests.documentId, documentId),
  )).limit(1) as Row[];
  return rows[0] ?? null;
}

async function insertRow(id: string, caller: AudiobookCaller, intent: AudiobookIntent): Promise<boolean> {
  const inserted = await db.insert(audiobookRequests).values({
    id,
    userId: caller.scope.storageUserId,
    documentId: intent.parsed.documentId,
    documentVersion: caller.scope.documentVersion,
    format: intent.format,
    speed: intent.speed,
    chapterIndex: intent.chapterIndex,
    settingsJson: toStoredRequest(intent) as never,
    planObjectKey: intent.parsed.planObjectKey ?? null,
  }).onConflictDoNothing().returning({ id: audiobookRequests.id }) as Array<{ id: string }>;
  return inserted.length > 0;
}

/** A new request restarts the retention period of one that already exists. */
async function renewRow(id: string, userId: string): Promise<void> {
  await db.update(audiobookRequests).set({ createdAt: Date.now() }).where(and(
    eq(audiobookRequests.id, id),
    eq(audiobookRequests.userId, userId),
  ));
}

async function deleteRow(id: string, userId: string): Promise<void> {
  await db.delete(audiobookRequests).where(and(
    eq(audiobookRequests.id, id),
    eq(audiobookRequests.userId, userId),
  ));
}

/**
 * Starts whichever step is due and reports where the audiobook stands. Every
 * step is idempotent and goes through compute admission, so GET, POST and the
 * worker's completion signal can all call this at any time.
 */
async function advanceAudiobook(input: {
  id: string;
  caller: AudiobookCaller;
  intent: AudiobookIntent;
  command: AudiobookCommand;
  includeProgress: boolean;
  onRunCancelled?: () => void;
}): Promise<Audiobook> {
  const { id, caller, intent, command } = input;
  const { scope, subject } = caller;
  const { documentId } = intent.parsed;
  const { format, speed, chapterIndex } = intent;
  const explicit = command === 'start' || command === 'retry-skipped';
  const runtimeConfig = await getRuntimeConfig();
  const client = new ComputeWorkerClient();
  const { settingsHash, settingsJson, planning } = await buildTtsPlaybackPlanningInput(intent.parsed, scope);

  const report = (fields: {
    generation: Audiobook['generation'];
    segments?: Audiobook['segments'];
    artifact?: Audiobook['artifact'];
    downloadUrl?: string | null;
    webDownloadUrl?: string | null;
    filename?: string | null;
    retryAfterMs?: number | null;
  }): Audiobook => {
    const artifact = fields.artifact ?? { state: 'none' as const, operationId: null, issue: null };
    const segments = fields.segments ?? null;
    return {
      id,
      documentId,
      status: audiobookStatus(fields.generation.state, artifact.state),
      progress: segments && segments.plannedSegments > 0
        ? Math.min(1, (segments.completedSegments + segments.skippedSegments) / segments.plannedSegments)
        : null,
      format,
      speed,
      chapter: chapterIndex,
      downloadUrl: fields.downloadUrl ?? null,
      filename: fields.filename ?? null,
      webUrl: webUrl(`/${scope.readerType}/${documentId}`),
      webDownloadUrl: fields.webDownloadUrl ?? null,
      retryAfterMs: fields.retryAfterMs ?? null,
      generation: fields.generation,
      segments,
      artifact,
    };
  };
  const reportGeneration = (
    state: TtsExportGenerationState,
    extra: { operationId?: string | null; issue?: TtsExportIssue | null; retryAfterMs?: number } = {},
  ) => report({
    generation: { state, operationId: extra.operationId ?? null, issue: extra.issue ?? null },
    retryAfterMs: extra.retryAfterMs ?? null,
  });

  let planObjectKey = intent.parsed.planObjectKey ?? null;
  if (!planObjectKey) {
    if (command === 'stop') return reportGeneration('stopped');
    let operation;
    if (command === 'read') {
      const existing = await findPlaybackPlanOperation({ parsed: intent.parsed, scope, planningInput: { settingsHash, settingsJson, planning } });
      if (!existing) return reportGeneration('idle');
      operation = existing;
    } else try {
      operation = await createAdmittedPlaybackPlanOperation({
        parsed: intent.parsed,
        scope,
        planningInput: { settingsHash, settingsJson, planning },
        policy: runtimeConfig.computeLimitPolicies,
        retryFailed: explicit,
      });
      // A very short plan can finish before its admission is linked, so its
      // callback may have found no owner. Observe it once after linking.
      if (operation.status === 'queued' || operation.status === 'running') {
        operation = await client.getOperation(operation.opId) ?? operation;
      }
    } catch (error) {
      if (explicit || !(error instanceof ComputeAdmissionLimitedError)) throw error;
      return reportGeneration('preparing', { retryAfterMs: error.retryAfterMs });
    }
    if (operation.status === 'queued' || operation.status === 'running') {
      return reportGeneration('preparing', { operationId: operation.opId });
    }
    const planResult = operation.result as TtsPlaybackPlanResult | undefined;
    if (operation.status === 'failed' || !planResult?.planObjectKey) {
      return reportGeneration('failed', { operationId: operation.opId, issue: exportOperationIssue(operation) });
    }
    planObjectKey = planResult.planObjectKey;
    if (command !== 'read') await db.update(audiobookRequests).set({ planObjectKey }).where(eq(audiobookRequests.id, id));
  }

  const sessionScope = {
    storageUserId: scope.storageUserId,
    documentId,
    documentVersion: scope.documentVersion,
    readerType: scope.readerType,
    settingsHash,
    planObjectKey,
    purpose: 'export-document' as const,
  };
  const sessionId = buildTtsPlaybackCanonicalSessionId(sessionScope);
  const artifactId = buildTtsPlaybackExportArtifactId({
    ...sessionScope,
    format,
    speed,
    ...(chapterIndex === null ? {} : { chapterIndex }),
  });
  const artifactScope = {
    artifactId,
    storageUserId: scope.storageUserId,
    documentId,
    documentVersion: scope.documentVersion,
    settingsHash,
    format,
    speed,
  };
  const progressScope = {
    storageUserId: scope.storageUserId,
    documentId,
    documentVersion: scope.documentVersion,
    settingsHash,
    planObjectKey,
  };

  let generationOperationId = intent.generationOperationId;
  const readGeneration = async (withProgress = false) => {
    const generation = await client.resolveTtsPlaybackSession(sessionScope);
    // Without a session (it expired, or none ever ran) the cache scope is
    // the only record of what was generated, so it is read even on a fast
    // lookup; otherwise a finished book would offer to generate again.
    const progress: TtsPlaybackExportProgressSummary | null = withProgress || !generation.session
      ? await client.getTtsPlaybackExportProgress(progressScope)
      : null;
    const classified = classifyExportGeneration(generation, progress);
    // Session expiry must not erase a failed/limited run and turn a read into
    // a new synthesis request. Keep only its reference in SQL, and read its
    // actual terminal state from the worker. Missing state needs explicit Resume.
    if (!generation.session && classified.state !== 'complete' && generationOperationId) {
      const operation = await client.getOperation(generationOperationId);
      const issue = exportOperationIssue(operation);
      const limited = operation?.progress && 'stopReason' in operation.progress && operation.progress.stopReason === 'usage_limit';
      return { generation: { ...generation, operation }, progress,
        state: (issue ? 'failed' : limited ? 'usage_limited' : 'interrupted') as TtsExportGenerationState,
        issue: issue ?? (limited ? { code: 'COMPUTE_USAGE_LIMIT_REACHED', message: null } : null) };
    }
    return { generation, progress, ...classified };
  };
  let current = await readGeneration(command === 'retry-skipped' || chapterIndex !== null);
  const rememberGeneration = async (operationId: string | undefined) => {
    if (!operationId || operationId === generationOperationId || command === 'read' || command === 'stop') return;
    generationOperationId = operationId;
    await db.update(audiobookRequests).set({
      settingsJson: toStoredRequest({ ...intent, generationOperationId }) as never,
    }).where(eq(audiobookRequests.id, id));
  };
  await rememberGeneration(current.generation.operation?.opId);

  const runActive = current.state === 'generating' || current.state === 'queued';
  if (command === 'stop' && runActive) {
    // Stop only the run this request observed; if a newer run replaced it
    // in the meantime, the report below describes that run instead.
    const observed = current.generation.session as { generationRunId?: unknown } | null;
    await client.cancelTtsPlaybackSession(
      sessionId,
      typeof observed?.generationRunId === 'string' ? observed.generationRunId : null,
    );
    input.onRunCancelled?.();
    current = await readGeneration();
  }

  // Advancing resumes a run that never began or was lost to a worker restart,
  // but a stop, a failure or a usage limit waits for an explicit command.
  const shouldStartGeneration = chapterIndex === null && !runActive && (
    (command === 'start' && current.state !== 'complete')
    || (command === 'retry-skipped' && (current.progress?.skippedSegments ?? 0) > 0)
    || (command === 'advance' && (current.state === 'idle'
      || (current.state === 'interrupted' && current.generation.session && !current.issue)))
  );
  let retryAfterMs: number | null = null;
  if (shouldStartGeneration) {
    const now = Date.now();
    try {
      const operation = await createAdmittedComputeOperation({
        policy: runtimeConfig.computeLimitPolicies,
        action: 'tts_playback_document',
        requestKey: buildTtsPlaybackAdmissionRequestKey(sessionId, now),
        subject,
        create: () => client.createTtsPlaybackOperation({
          sessionId,
          userId: scope.userId,
          storageUserId: scope.storageUserId,
          documentId,
          documentVersion: scope.documentVersion,
          readerType: scope.readerType,
          settingsHash,
          settingsJson,
          planObjectKey,
          expiresAt: now + TTS_PLAYBACK_SESSION_TTL_MS,
          aheadWindow: TTS_PLAYBACK_AHEAD_WINDOW,
          backgroundExtent: 'document',
          generationExtent: 'document',
          // A new run id per observed state supersedes a stopped run that is
          // still draining, while concurrent duplicate starts share one run.
          generationRunId: exportGenerationRunId({
            sessionId,
            action: command === 'retry-skipped' ? 'retry-skipped' : 'start',
            session: current.generation.session,
          }),
          ...(command === 'retry-skipped' ? { retryErroredSegments: true } : {}),
          planning: { ...planning, selectedOrdinal: 0 },
        }),
      });
      await rememberGeneration(operation.opId);
      current = await readGeneration();
    } catch (error) {
      if (explicit || !(error instanceof ComputeAdmissionLimitedError)) throw error;
      retryAfterMs = error.retryAfterMs;
    }
  }

  // Commands have already been applied. Chapter discovery must never gate Stop.
  if (input.includeProgress && !current.progress) {
    current.progress = await client.getTtsPlaybackExportProgress(progressScope);
  }
  const chapter = chapterIndex === null ? null : current.progress?.chapters[chapterIndex] ?? null;
  if (chapterIndex !== null && !chapter) throw new ChapterNotFoundError();
  const counts = chapter ?? (current.progress
    ? { completedSegments: current.progress.completedSegments, skippedSegments: current.progress.skippedSegments }
    : current.generation.progress
      ? { completedSegments: current.generation.progress.completedCount,
        skippedSegments: current.generation.progress.skippedCount ?? 0 }
      : null);
  // A whole book needs a finished run; one chapter only needs its own
  // segments settled, so it can be downloaded while generation continues.
  const settled = chapter
    ? chapter.completedSegments > 0
      && chapter.completedSegments + chapter.skippedSegments === chapter.plannedSegments
    : current.state === 'complete';

  let artifact = await client.resolveTtsPlaybackExportArtifact(artifactScope);
  let artifactState: TtsExportArtifactState = classifyExportArtifact({ artifact, counts });
  // A failed build is only retried on request, so advancing cannot loop on it.
  // A whole-book run that finished after it changed the audio, so that one is new work.
  const failedBeforeLatestRun = chapterIndex === null && artifactState === 'failed'
    && (current.generation.operation?.updatedAt ?? 0) > (artifact.operation?.updatedAt ?? Number.POSITIVE_INFINITY);
  const shouldBuild = settled && (
    ((command === 'start' || command === 'retry-skipped') && artifactState !== 'ready' && artifactState !== 'building')
    || (command === 'advance' && (artifactState === 'none' || artifactState === 'stale' || failedBeforeLatestRun))
  );
  // A file counts toward storage like the audio it is built from, so a full account can't add more.
  const blockedStorage = shouldBuild ? await storageLimit(subject, 0, runtimeConfig) : null;
  let artifactIssue: TtsExportIssue | null = null;
  if (blockedStorage) {
    artifactState = 'failed';
    artifactIssue = { code: blockedStorage.code, message: blockedStorage.message };
  } else if (shouldBuild) {
    try {
      await createAdmittedComputeOperation({
        policy: runtimeConfig.computeLimitPolicies,
        action: 'tts_playback_export',
        requestKey: artifactId,
        subject,
        create: () => client.createTtsPlaybackExportArtifactOperation({
          artifactId,
          sessionId,
          userId: scope.userId,
          storageUserId: scope.storageUserId,
          documentId,
          documentVersion: scope.documentVersion,
          readerType: scope.readerType,
          settingsHash,
          settingsJson,
          planObjectKey,
          format,
          speed,
          ...(chapterIndex === null ? {} : { chapterIndex }),
        }),
      });
      artifact = await client.resolveTtsPlaybackExportArtifact(artifactScope);
      artifactState = classifyExportArtifact({ artifact, counts });
    } catch (error) {
      if (!(error instanceof ComputeAdmissionLimitedError)) throw error;
      artifactState = 'waiting';
      retryAfterMs = error.retryAfterMs;
    }
  }

  const ready = artifactState === 'ready' ? artifact.artifact : null;
  return report({
    generation: {
      state: current.state,
      operationId: current.generation.operation?.opId ?? null,
      issue: current.issue,
    },
    segments: current.progress ? {
      plannedSegments: current.progress.plannedSegments,
      completedSegments: current.progress.completedSegments,
      skippedSegments: current.progress.skippedSegments,
      lastSkipIssue: current.progress.lastSkipError,
      chapters: current.progress.chapters,
    } : null,
    artifact: {
      state: artifactState,
      operationId: artifact.operation?.opId ?? null,
      issue: artifactIssue ?? (artifactState === 'failed' ? exportOperationIssue(artifact.operation) : null),
    },
    downloadUrl: ready ? `/api/v1/documents/${documentId}/audiobooks/files/${artifactId}` : null,
    webDownloadUrl: ready ? webUrl(`/audiobooks/${documentId}/${artifactId}`) : null,
    filename: ready?.dispositionFilename ?? null,
    retryAfterMs,
  });
}

async function idFor(caller: AudiobookCaller, intent: AudiobookIntent): Promise<string> {
  const { settingsHash } = await buildTtsPlaybackPlanningInput(intent.parsed, caller.scope);
  return audiobookId(caller, intent, settingsHash);
}

/** Records the request and starts it, or returns the matching existing one. */
async function startAudiobookUnlocked(
  caller: AudiobookCaller,
  intent: AudiobookIntent,
  options: { retrySkipped: boolean; includeProgress: boolean },
): Promise<Audiobook> {
  const id = await idFor(caller, intent);
  const command = options.retrySkipped ? 'retry-skipped' : 'start';
  const existing = await findRow(id, caller.scope.storageUserId, intent.parsed.documentId);
  const stored = existing ? intentFromRow(existing) : null;
  const effective: AudiobookIntent = stored?.parsed.planObjectKey ? stored : intent;
  // A chapter never starts generation. Its row is kept from the start, so the returned
  // id can be read until the chapter is ready and its file is built.
  if (intent.chapterIndex !== null) {
    const audiobook = await advanceAudiobook({ id, caller, intent: effective, command, includeProgress: true });
    if (!await insertRow(id, caller, effective)) await renewRow(id, caller.scope.storageUserId);
    return audiobook;
  }
  const inserted = await insertRow(id, caller, effective);
  if (!inserted) await renewRow(id, caller.scope.storageUserId);
  try {
    return await advanceAudiobook({ id, caller, intent: effective, command, includeProgress: options.includeProgress });
  } catch (error) {
    // Admission refusal starts no audio. A transient read/network failure can
    // happen after enqueueing, so retain that intent for the completion signal.
    if (inserted && error instanceof ComputeAdmissionLimitedError) {
      await deleteRow(id, caller.scope.storageUserId).catch(() => undefined);
    }
    throw error;
  }
}

/** Reports the audiobook for these settings without asking for one. */
async function lookupAudiobookUnlocked(
  caller: AudiobookCaller,
  intent: AudiobookIntent,
  options: { includeProgress: boolean },
): Promise<Audiobook> {
  const id = await idFor(caller, intent);
  const row = await findRow(id, caller.scope.storageUserId, intent.parsed.documentId);
  const stored = row ? intentFromRow(row) : null;
  const audiobook = await advanceAudiobook({
    id,
    caller,
    intent: stored?.parsed.planObjectKey ? stored : intent,
    command: row && caller.mayGenerate ? 'advance' : 'read',
    includeProgress: options.includeProgress,
  });
  // A run with no request predates this table; adopting it lets it be stopped
  // and lets its file be built when it finishes.
  const running = audiobook.generation.state === 'generating' || audiobook.generation.state === 'queued';
  if (!row && running && caller.mayGenerate && intent.chapterIndex === null) await insertRow(id, caller, {
    ...intent, generationOperationId: audiobook.generation.operationId ?? undefined,
  });
  return audiobook;
}

async function loadRequested(caller: AudiobookCaller, id: string, documentId: string) {
  const row = await findRow(id, caller.scope.storageUserId, documentId);
  if (!row) return null;
  const intent = intentFromRow(row);
  // A changed document is a different audiobook: its plan and audio no longer apply.
  if (!intent || Number(row.documentVersion) !== caller.scope.documentVersion) {
    await deleteRow(id, caller.scope.storageUserId);
    return null;
  }
  return intent;
}

async function getAudiobookUnlocked(
  caller: AudiobookCaller,
  id: string,
  documentId: string,
): Promise<Audiobook | null> {
  const intent = await loadRequested(caller, id, documentId);
  if (!intent) return null;
  return advanceAudiobook({ id, caller, intent, command: caller.mayGenerate ? 'advance' : 'read', includeProgress: true });
}

/**
 * Stops generation and ends the request. Audio generated so far stays cached.
 * Formats and speeds share one generation, so cancelling it also ends the other
 * whole-book requests on that session; a new POST resumes any of them.
 */
async function stopAudiobookUnlocked(
  caller: AudiobookCaller,
  id: string,
  documentId: string,
): Promise<Audiobook | null> {
  const intent = await loadRequested(caller, id, documentId);
  if (!intent) return null;
  if (intent.chapterIndex !== null) throw new ChapterCommandError();
  let runCancelled = false;
  const audiobook = await advanceAudiobook({
    id,
    caller,
    intent,
    command: 'stop',
    includeProgress: false,
    onRunCancelled: () => { runCancelled = true; },
  });
  await deleteRow(id, caller.scope.storageUserId);
  if (runCancelled) await deleteRequestsSharingSession(caller, intent);
  return audiobook;
}

async function deleteRequestsSharingSession(caller: AudiobookCaller, stopped: AudiobookIntent): Promise<void> {
  const { documentId } = stopped.parsed;
  const { settingsHash } = await buildTtsPlaybackPlanningInput(stopped.parsed, caller.scope);
  const rows = await db.select().from(audiobookRequests).where(and(
    eq(audiobookRequests.userId, caller.scope.storageUserId),
    eq(audiobookRequests.documentId, documentId),
  )) as Row[];
  for (const row of rows) {
    if (row.chapterIndex !== null || Number(row.documentVersion) !== caller.scope.documentVersion) continue;
    const intent = intentFromRow(row);
    if (!intent) continue;
    const planned = await buildTtsPlaybackPlanningInput(intent.parsed, caller.scope);
    if (planned.settingsHash === settingsHash) await deleteRow(row.id, caller.scope.storageUserId);
  }
}

export function startAudiobook(caller: AudiobookCaller, intent: AudiobookIntent, options: { retrySkipped: boolean; includeProgress: boolean }): Promise<Audiobook> {
  return withAudiobookLock(caller, intent.parsed.documentId, () => startAudiobookUnlocked(caller, intent, options));
}

export function lookupAudiobook(caller: AudiobookCaller, intent: AudiobookIntent, options: { includeProgress: boolean }): Promise<Audiobook> {
  return withAudiobookLock(caller, intent.parsed.documentId, () => lookupAudiobookUnlocked(caller, intent, options));
}

export function getAudiobook(caller: AudiobookCaller, id: string, documentId: string): Promise<Audiobook | null> {
  return withAudiobookLock(caller, documentId, () => getAudiobookUnlocked(caller, id, documentId));
}

export function stopAudiobook(caller: AudiobookCaller, id: string, documentId: string): Promise<Audiobook | null> {
  return withAudiobookLock(caller, documentId, () => stopAudiobookUnlocked(caller, id, documentId));
}

// A signal is the only thing that moves a closed tab's audiobook on, so it waits out
// a command that holds the lock instead of being dropped. The holder may have read
// the worker before this operation finished.
const SIGNAL_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

async function advanceWhenFree<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const busy = error instanceof ApiRequestError && error.code === 'AUDIOBOOK_BUSY';
      if (!busy || attempt >= SIGNAL_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, SIGNAL_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * The worker's completion signal. It has no client request, so no IP or guest
 * device ID: only signed-in users' requests advance here, with limits keyed on
 * the stored user. A guest's export is compiled when they next have it open.
 */
export async function advanceAudiobooksAfterOperation(operationId: string, userId: string): Promise<void> {
  if (!isComputeWorkerAvailable()) return;
  const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
  const users = await db.select({ isAnonymous: authSchema.user.isAnonymous })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, userId))
    .limit(1) as Array<{ isAnonymous: boolean | null }>;
  if (!users[0] || users[0].isAnonymous) return;

  const operation = await new ComputeWorkerClient().getOperation(operationId);
  const documentId = (operation?.subject as { documentId?: unknown } | undefined)?.documentId;
  if (typeof documentId !== 'string') return;
  const scope = await resolveUserDocumentScope({ userId, isAnonymous: false }, documentId);
  if (!scope) return;

  const rows = await db.select({ id: audiobookRequests.id }).from(audiobookRequests).where(and(
    eq(audiobookRequests.userId, userId),
    eq(audiobookRequests.documentId, documentId),
  )) as Array<{ id: string }>;
  const caller: AudiobookCaller = { scope, subject: { userId, isAnonymous: false }, mayGenerate: true };
  for (const { id } of rows) {
    await advanceWhenFree(() => getAudiobook(caller, id, documentId)).catch((error: unknown) => {
      logDegraded(serverLogger, {
        event: 'audiobooks.advance_signal.failed',
        msg: 'Failed to advance an audiobook after a worker operation finished',
        step: 'advance_audiobook',
        context: { documentId, operationId },
        error,
      });
    });
  }
}

const SETTLED_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 200;
const UNSETTLED: ReadonlySet<AudiobookStatus> = new Set(['preparing', 'queued', 'generating', 'building', 'waiting']);

/**
 * Ends requests past their retention once nothing is left to do for them. Files
 * and audio are unaffected, and a new POST finds them again. Only observes, so
 * it never starts work for a request nobody is watching.
 */
export async function pruneSettledAudiobookRequests(now: number, deadlineAt: number): Promise<number> {
  if (!isComputeWorkerAvailable()) return 0;
  let removed = 0;
  // Rows still in use stay put, so later batches skip past them instead of rereading them forever.
  let kept = 0;
  while (Date.now() < deadlineAt) {
    const rows = await db.select({
      id: audiobookRequests.id,
      userId: audiobookRequests.userId,
      documentId: audiobookRequests.documentId,
    }).from(audiobookRequests)
      .where(lt(audiobookRequests.createdAt, now - SETTLED_REQUEST_RETENTION_MS))
      .orderBy(asc(audiobookRequests.createdAt), asc(audiobookRequests.id))
      .limit(PRUNE_BATCH)
      .offset(kept) as Array<{ id: string; userId: string; documentId: string }>;
    for (const { id, userId, documentId } of rows) {
      if (Date.now() >= deadlineAt) return removed;
      const outcome = await pruneRequest(id, userId, documentId);
      // A worker outage only postpones the rest until the next run.
      if (outcome === 'stop') return removed;
      if (outcome === 'removed') removed += 1;
      else kept += 1;
    }
    if (rows.length < PRUNE_BATCH) break;
  }
  return removed;
}

async function pruneRequest(id: string, userId: string, documentId: string): Promise<'removed' | 'kept' | 'stop'> {
  const scope = await resolveUserDocumentScope({ userId, isAnonymous: false }, documentId);
  if (!scope) {
    // The document is gone, and these rows would otherwise fill every batch.
    await deleteRow(id, userId);
    return 'removed';
  }
  const caller: AudiobookCaller = { scope, subject: { userId, isAnonymous: false }, mayGenerate: false };
  try {
    return await withAudiobookLock(caller, documentId, async () => {
      // A chapter that no longer exists has nothing left to do.
      const settled = await getAudiobookUnlocked(caller, id, documentId).then(
        // A ready file says nothing about a run that is still changing the audio.
        audiobook => audiobook !== null && !UNSETTLED.has(audiobook.status) && !UNSETTLED.has(audiobook.generation.state),
        (error: unknown) => {
          if (error instanceof ChapterNotFoundError) return true;
          throw error;
        },
      );
      if (!settled) return 'kept';
      await deleteRow(id, userId);
      return 'removed';
    });
  } catch (error) {
    if (isComputeWorkerUnavailableError(error)) return 'stop';
    if (!(error instanceof ApiRequestError)) {
      logDegraded(serverLogger, {
        event: 'audiobooks.prune.failed',
        msg: 'Failed to check an old audiobook request',
        step: 'prune_audiobook_request',
        context: { documentId },
        error,
      });
    }
    return 'kept';
  }
}
