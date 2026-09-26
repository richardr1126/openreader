import { createHash } from 'node:crypto';
import type {
  ComputeOperation,
  TtsPlaybackExportArtifactResolution,
  TtsPlaybackSessionResolution,
} from '@/lib/server/compute-worker/protocol';
import type {
  TtsExportAction,
  TtsExportArtifactState,
  TtsExportGenerationState,
  TtsExportIssue,
} from '@/types/tts-export';

const EXPORT_ACTIONS: readonly TtsExportAction[] = ['resolve', 'start', 'retry-skipped', 'stop'];

/**
 * Run id for a document export start, derived from the session state the
 * request observed. Concurrent starts (double click, two tabs) that saw the
 * same state get the same run id, so the worker's operation key dedupes them
 * into one run; any later start sees a changed session and gets a new run.
 */
export function exportGenerationRunId(input: {
  sessionId: string;
  action: TtsExportAction;
  session: unknown;
}): string {
  const observed = input.session && typeof input.session === 'object'
    ? input.session as { generationRunId?: unknown; status?: unknown; updatedAt?: unknown }
    : null;
  return createHash('sha256')
    .update(JSON.stringify([
      input.sessionId,
      input.action,
      observed?.generationRunId ?? null,
      observed?.status ?? null,
      observed?.updatedAt ?? null,
    ]))
    .digest('hex')
    .slice(0, 32);
}

export function parseTtsExportAction(value: unknown): TtsExportAction {
  return EXPORT_ACTIONS.find((candidate) => candidate === value) ?? 'resolve';
}

function isInflight(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export function exportOperationIssue(operation: ComputeOperation | null | undefined): TtsExportIssue | null {
  if (operation?.status !== 'failed') return null;
  const error = operation.error as { message?: unknown; code?: unknown } | null | undefined;
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    message: typeof error?.message === 'string' ? error.message : null,
  };
}

/**
 * The durable export session is the generation authority; its current worker
 * operation tells whether a queued/running session still has a live run.
 */
export function classifyExportGeneration(generation: TtsPlaybackSessionResolution): {
  state: TtsExportGenerationState;
  issue: TtsExportIssue | null;
} {
  const session = generation.session && typeof generation.session === 'object'
    ? generation.session as { status?: unknown; stopReason?: unknown; lastError?: unknown }
    : null;
  if (!session) return { state: 'idle', issue: null };
  const lastError = typeof session.lastError === 'string' && session.lastError ? session.lastError : null;
  switch (session.status) {
    case 'succeeded':
      return session.stopReason === 'usage_limit'
        ? { state: 'usage_limited', issue: { code: 'COMPUTE_USAGE_LIMIT_REACHED', message: null } }
        : { state: 'complete', issue: null };
    case 'canceled':
      return { state: 'stopped', issue: null };
    case 'failed':
      return {
        state: 'failed',
        issue: exportOperationIssue(generation.operation) ?? { code: null, message: lastError },
      };
    default:
      // A queued/running session whose run already ended (worker restart,
      // orphan recovery, or a run that stopped early) must be resumable rather
      // than reported as generating forever.
      if (generation.operation?.status === 'queued') return { state: 'queued', issue: null };
      if (generation.operation?.status === 'running') return { state: 'generating', issue: null };
      return {
        state: 'interrupted',
        issue: exportOperationIssue(generation.operation),
      };
  }
}

export function classifyExportArtifact(input: {
  artifact: TtsPlaybackExportArtifactResolution;
  counts: { completedSegments: number; skippedSegments: number } | null;
}): TtsExportArtifactState {
  const ready = input.artifact.artifact;
  if (ready) {
    // Deterministic artifact ids outlive retries of skipped segments; a file
    // built from different sidecar counts is replaced rather than offered.
    const stale = input.counts !== null && (
      (ready.generatedSegments ?? input.counts.completedSegments) !== input.counts.completedSegments
      || (ready.skippedSegments ?? 0) !== input.counts.skippedSegments
    );
    if (!stale) return 'ready';
  }
  const status = input.artifact.operation?.status;
  if (isInflight(status)) return 'building';
  if (ready) return 'stale';
  return status === 'failed' ? 'failed' : 'none';
}
