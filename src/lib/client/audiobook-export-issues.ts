import { TtsExportRequestError } from '@/lib/client/api/tts';
import type {
  TtsExportGenerationState,
  TtsExportIssue,
  TtsExportResolveSnapshot,
} from '@/types/tts-export';

const MAX_DETAIL_LENGTH = 180;
const CONNECTION_FAILURE = /connection error|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network/i;

function formatWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

function detail(message: string | null): string | null {
  const trimmed = message?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH - 1)}…` : trimmed;
}

/** One-sentence cause for a worker or provider failure code. */
export function describeExportIssue(issue: TtsExportIssue | null): string | null {
  if (!issue) return null;
  const raw = detail(issue.message);
  switch (issue.code) {
    case 'COMPUTE_USAGE_LIMIT_REACHED':
      return 'The text-to-speech usage limit for your account was reached.';
    case 'COMPUTE_QUEUE_AGE_EXCEEDED':
      return 'It waited too long for other audiobook exports on this server to finish.';
    case 'WORKER_ORPHANED_OP':
      return 'The compute worker stopped while generating (for example, it restarted).';
    case 'COMPUTE_WORK_NOT_STARTED':
      return 'The compute worker stopped or was too busy before this export could start.';
    case 'UPSTREAM_TIMEOUT':
      return 'The TTS provider took too long to respond.';
    case 'UPSTREAM_RATE_LIMIT':
      return 'The TTS provider rate-limited requests (HTTP 429).';
    case 'UPSTREAM_ERROR':
      return raw ? `The TTS provider returned an error: ${raw}` : 'The TTS provider returned an error.';
    default:
      if (raw && CONNECTION_FAILURE.test(raw)) {
        return `Could not reach the TTS provider (${raw}). Check that it is running, then retry.`;
      }
      return raw ? `TTS request failed: ${raw}` : null;
  }
}

/** Status line for a generation run that is not currently producing audio. */
export function describeGenerationState(
  state: TtsExportGenerationState,
  issue: TtsExportIssue | null,
): string | null {
  const cause = describeExportIssue(issue);
  switch (state) {
    case 'queued':
      return 'Queued: another audiobook export on this server is generating. This one starts automatically when a slot frees up.';
    case 'stopped':
      return 'Generation stopped. Audio generated so far is kept; resume to continue.';
    case 'usage_limited':
      return 'Generation paused: the text-to-speech usage limit was reached. Audio generated so far is kept; resume after the limit resets.';
    case 'interrupted':
      return `Generation stopped before finishing.${cause ? ` ${cause}` : ''} Resume to continue from the audio already generated.`;
    case 'failed':
      return `Generation failed.${cause ? ` ${cause}` : ''} Resume to retry from the audio already generated.`;
    default:
      return null;
  }
}

export function describeSkippedSegments(snapshot: TtsExportResolveSnapshot | null): string | null {
  const skipped = snapshot?.progress?.skippedSegments ?? 0;
  if (skipped <= 0) return null;
  const cause = describeExportIssue(snapshot?.progress?.lastSkipIssue ?? null);
  return `${skipped} ${skipped === 1 ? 'segment' : 'segments'} could not be narrated and ${skipped === 1 ? 'was' : 'were'} replaced with a short pause.${cause ? ` Last error: ${cause}` : ''}`;
}

/** Message for a failed export request (admission limits, network, server). */
export function describeExportRequestError(error: unknown): string {
  if (error instanceof TtsExportRequestError) {
    if (error.code === 'COMPUTE_ADMISSION_RATE_LIMITED' || error.status === 429) {
      return error.retryAfterMs
        ? `Too many audiobook requests right now. Try again in ${formatWait(error.retryAfterMs)}.`
        : 'Too many audiobook requests right now. Try again shortly.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Audiobook export request failed.';
}
