/**
 * The single definition of the playback generation floor.
 *
 * The audio stream's scaffolding-silence boundary (api/routes.ts) and the
 * worker's generation lower bound (jobs/playback/playback-job.ts) MUST be computed from the
 * exact same formula. If they ever drift, the stream can advertise "real audio
 * coming" for an ordinal the worker never generates — the browser then waits
 * forever (the `bytes=0-` probe hang). Routing both through this one helper
 * makes that drift impossible by construction.
 *
 * The floor follows the cursor: generation centers on where the user is, and
 * everything below the floor is scaffolding silence. There is intentionally NO
 * clamp to the original start — a backward seek below the start lowers the
 * cursor, which lowers the floor, so the worker re-generates real audio there
 * instead of serving silence.
 *
 * `TTS_PLAYBACK_BACKWARD_PAD` is a tunable cushion of segments generated just
 * *behind* the cursor so a small backward nudge has audio ready without a
 * buffering wait. It is 0 today: a non-zero pad would delay first audio at a
 * deep start by that many segments, which regresses "start exactly here, no
 * grind." The knob is kept so the trade-off can be revisited in one place.
 */
export const TTS_PLAYBACK_BACKWARD_PAD = 0;
// Dialogue-heavy books need more ordinal runway because a single spoken unit
// can be only a few words. The client presents the resulting runway in seconds;
// this ordinal ceiling is intentionally generous while keeping generation
// bounded and cancellable.
export const DEFAULT_TTS_PLAYBACK_AHEAD_WINDOW = 48;

export function generationFloorForCursor(cursorOrdinal: number): number {
  const cursor = Math.max(0, Math.floor(Number(cursorOrdinal) || 0));
  return Math.max(0, cursor - TTS_PLAYBACK_BACKWARD_PAD);
}

/**
 * Whether a running window's in-flight synthesis is still wanted at a moved
 * cursor. A run generates in plan order, so the segment after its completion
 * watermark is the one it has in flight. Once that segment falls outside the
 * cursor's window, finishing it only delays the audio the listener is waiting
 * for. An unknown watermark (nothing completed yet) is treated as still wanted.
 */
export function playbackRunServesCursor(input: {
  completedThroughOrdinal: number | null;
  cursorOrdinal: number;
  aheadWindow: number;
}): boolean {
  if (input.completedThroughOrdinal == null || input.completedThroughOrdinal < 0) return true;
  const inFlightOrdinal = input.completedThroughOrdinal + 1;
  return inFlightOrdinal >= generationFloorForCursor(input.cursorOrdinal)
    && inFlightOrdinal <= input.cursorOrdinal + input.aheadWindow;
}
