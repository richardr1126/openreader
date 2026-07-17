import { Readable } from 'node:stream';
import { verifyTtsPlaybackToken } from '@openreader/tts/playback-token';
import {
  cumulativeCbrFrameBytes,
  getCbrSilenceFrameLengths,
  getCbrSilenceSecond,
  MP3_FRAME_DURATION_MS,
} from '@openreader/tts/audio-format';
import { requireEnv } from '../../../infrastructure/config';
import { generationFloorForCursor } from '../../../playback/generation-window';
import {
  buildByteLayout,
  locateByte,
  parseRangeHeader,
  resolvePlaybackStreamStartOrdinal,
  type PlanSlotInput,
} from '../../playback-audio-layout';
import type { PlaybackSessionController } from '../../playback/session-controller';
import type { PlaybackSessionReadModel, PlaybackSessionRow } from '../../playback/session-read-model';
import type { ComputeWorkerRouteContext } from '../../route-context';
import {
  errorCode,
  isMissingObjectError,
  toErrorMessage,
} from '../../route-context';
import { apiErrorResponseSchema, jsonSchema } from '../../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);
const ESTIMATE_MS_PER_CHAR_BASE = 78;

function estimateRateForSession(session: PlaybackSessionRow): number {
  const speedRaw = (session.settingsJson as { nativeSpeed?: unknown } | null)?.nativeSpeed;
  const speed = Number(speedRaw);
  const clamped = Number.isFinite(speed) && speed > 0 ? Math.min(3, Math.max(0.5, speed)) : 1;
  return ESTIMATE_MS_PER_CHAR_BASE / clamped;
}

function stripId3Tag(bytes: Buffer): Buffer {
  if (bytes.length < 10 || bytes.subarray(0, 3).toString('ascii') !== 'ID3') return bytes;
  const size =
    ((bytes[6] & 0x7f) << 21)
    | ((bytes[7] & 0x7f) << 14)
    | ((bytes[8] & 0x7f) << 7)
    | (bytes[9] & 0x7f);
  const end = 10 + size;
  return end > 0 && end < bytes.length ? bytes.subarray(end) : bytes;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function registerPlaybackAudioRoutes(
  context: ComputeWorkerRouteContext,
  readModel: PlaybackSessionReadModel,
  controller: PlaybackSessionController,
): void {
  const { app, storage, markActivity } = context;

  app.get('/v1/tts-playback/sessions/:sessionId/audio', {
    schema: {
      security: [],
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      querystring: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          fromOrdinal: { type: 'integer', minimum: 0 },
        },
        required: ['token'],
      },
      response: {
        200: { type: 'string', description: 'Progressive MP3 audio stream' },
        206: { type: 'string', description: 'Progressive MP3 audio byte range' },
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
        416: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const query = request.query as { token?: string; fromOrdinal?: number | string };
    const sessionId = params.sessionId?.trim() ?? '';
    if (!sessionId || !query.token) {
      reply.code(400);
      return { error: 'Missing playback session id or token' };
    }

    let tokenPayload: ReturnType<typeof verifyTtsPlaybackToken>;
    try {
      tokenPayload = verifyTtsPlaybackToken(query.token, requireEnv('TTS_PLAYBACK_TOKEN_SECRET'));
    } catch (error) {
      reply.code(403);
      return { error: toErrorMessage(error) };
    }
    if (tokenPayload.sessionId !== sessionId) {
      reply.code(403);
      return { error: 'Playback token session mismatch' };
    }

    const initialSession = await readModel.readSession(sessionId);
    if (!initialSession) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    if (
      initialSession.userId !== tokenPayload.userId
      || initialSession.storageUserId !== tokenPayload.storageUserId
      || initialSession.documentId !== tokenPayload.documentId
    ) {
      reply.code(403);
      return { error: 'Playback token scope mismatch' };
    }

    let closed = false;
    request.raw.on('close', () => {
      closed = true;
      app.log.info({ sessionId }, 'tts.playback.audio.client_closed');
    });

    const startedAt = Date.now();

    // Resolve a snapshot of the stream layout before sending headers: we need a
    // stable total byte size for Content-Length / seeking. The total is a
    // deterministic char-based estimate over the whole window (independent of how
    // much is generated, so it never changes between range requests), while the
    // byte→ordinal map uses exact durations where generated so seeks land on the
    // correct segment. CBR makes both linear (see STREAM_AUDIO_PROFILE).
    type Layout = { totalBytes: number; slots: ReturnType<typeof buildByteLayout>['slots'] };
    type Resolved =
      | { kind: 'ok'; total: number; mapLayout: Layout }
      | { kind: 'error'; code: 400 | 404 | 409 | 503; message: string };

    const resolveLayout = async (): Promise<Resolved> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (closed) return { kind: 'error', code: 409, message: 'Client disconnected' };
        const session = await readModel.readSession(sessionId);
        if (!session) return { kind: 'error', code: 404, message: 'Playback session not found' };
        if (Date.now() > session.expiresAt) {
          return { kind: 'error', code: 404, message: 'Playback session expired' };
        }
        if (session.status !== 'queued' && session.status !== 'running' && session.status !== 'succeeded') {
          return { kind: 'error', code: 409, message: 'Playback session is no longer active' };
        }
        if (session.planObjectKey) {
          const planSegments = await readModel.readPlanSegments(session.planObjectKey);
          if (planSegments) {
            const startOrdinal = resolvePlaybackStreamStartOrdinal(
              planSegments.map((segment) => segment.ordinal),
              session.generationStartOrdinal,
              query.fromOrdinal,
            );
            if (startOrdinal === null) {
              return { kind: 'error', code: 400, message: 'Playback stream start ordinal is not present in the canonical plan' };
            }
            const completed = await readModel.listCompletedDurations(session, planSegments.length);
            const estimateRate = estimateRateForSession(session);
            // Size every not-yet-generated (silence) slot in WHOLE MP3 frames, with
            // its exact frame byte length, so the silence we emit decodes to exactly
            // the duration the byte/time grid advertises. Without this, each silence
            // slot is sliced mid-frame and drops a partial frame on decode, drifting
            // the highlight ahead of the audio (worst at deep starts / long prefixes).
            const silenceFrameLengths = await getCbrSilenceFrameLengths().catch(() => [] as number[]);
            const layoutOptions = {
              frameDurationMs: MP3_FRAME_DURATION_MS,
              silenceBytesForFrames: silenceFrameLengths.length > 0
                ? (frames: number) => cumulativeCbrFrameBytes(silenceFrameLengths, frames)
                : undefined,
            };
            // Real durations where generated (so the byte map matches the gapless
            // real audio and seeking lands accurately within the generated region),
            // frame-quantized silence for the not-yet-generated tail.
            const mapSlots: PlanSlotInput[] = planSegments.map((segment) => ({
              ordinal: segment.ordinal,
              text: segment.text,
              durationMs: completed.get(segment.ordinal) ?? null,
            }));
            const totalSlots: PlanSlotInput[] = planSegments.map((segment) => ({
              ordinal: segment.ordinal,
              text: segment.text,
              durationMs: null, // pure estimate → stable Content-Length across requests
            }));
            const mapLayout = buildByteLayout(mapSlots, startOrdinal, estimateRate, layoutOptions);
            const total = buildByteLayout(totalSlots, startOrdinal, estimateRate, layoutOptions).totalBytes;
            return { kind: 'ok', total, mapLayout };
          }
        }
        if (Date.now() > deadline) {
          return { kind: 'error', code: 503, message: 'Playback plan not ready' };
        }
        markActivity('tts_playback_audio_wait');
        await sleep(250);
      }
    };

    const resolved = await resolveLayout();
    if (resolved.kind === 'error') {
      reply.code(resolved.code);
      return { error: resolved.message };
    }
    const { total, mapLayout } = resolved;

    const rangeHeaderRaw = request.headers.range;
    const rangeHeader = Array.isArray(rangeHeaderRaw) ? rangeHeaderRaw[0] : rangeHeaderRaw;
    const parsedRange = parseRangeHeader(rangeHeader, total);

    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Accel-Buffering', 'no');
    reply.header('Accept-Ranges', 'bytes');

    if (parsedRange === 'unsatisfiable') {
      reply.code(416);
      reply.header('Content-Range', `bytes */${total}`);
      return { error: 'Requested range not satisfiable' };
    }

    // null (no Range) and 'invalid' (malformed/multi-range) both serve the full body.
    const range = parsedRange && parsedRange !== 'invalid'
      ? parsedRange
      : { start: 0, end: Math.max(0, total - 1) };

    if (parsedRange && parsedRange !== 'invalid') {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    } else {
      reply.code(200);
    }
    reply.header('Content-Length', String(total === 0 ? 0 : range.end - range.start + 1));

    // Stream the requested byte window: real (gapless, ID3-stripped) segment audio
    // from the mapped position, waiting for the worker to generate pending segments,
    // then valid CBR silence to pad up to the advertised length (never truncated).
    const streamRange = async function* (): AsyncGenerator<Buffer> {
      if (total === 0) return;
      const need = range.end - range.start + 1;
      if (need <= 0) return;
      let sent = 0;
      const startLoc = locateByte(mapLayout, range.start);
      let slotIdx = startLoc ? startLoc.slotIndex : mapLayout.slots.length;
      let skipWithin = startLoc ? startLoc.offsetWithin : 0;
      let wroteFirstByte = false;
      let silenceUnit: Buffer | null = null;

      // The ordinal at the requested byte window's start IS the playhead this
      // request will play from. The browser controls it directly, so it is
      // race-proof: unlike `session.cursorOrdinal` (which the client's seek POST
      // may not have landed yet), it always reflects the user's seek target.
      //
      // For any seek (start ordinal > 0) we drive the cursor here so generation
      // re-centers on the target — a forward seek jumps generation ahead, a
      // backward seek (even below the original start) jumps it behind — without
      // depending on the client POST winning the race against this request. We
      // deliberately do NOT do this for the `bytes=0-` probe (start ordinal 0):
      // that request must NOT pull generation back to 0 on a deep start, and it
      // relies on scaffolding silence to complete instantly.
      const rangeStartOrdinal = startLoc ? mapLayout.slots[startLoc.slotIndex].ordinal : 0;
      if (rangeStartOrdinal > 0) {
        await controller.updateCursor(sessionId, rangeStartOrdinal).catch((error) => {
          app.log.warn({ sessionId, ordinal: rangeStartOrdinal, error: toErrorMessage(error) }, 'tts.playback.cursor_seed_failed');
        });
      }

      const streamSilence = async function* (byteCount: number): AsyncGenerator<Buffer> {
        let written = 0;
        while (written < byteCount && !closed) {
          if (silenceUnit === null) {
            // ID3-strip the silence unit so it is exactly whole MP3 frames: ffmpeg
            // prepends a ~44B ID3v2 tag, and repeating/slicing a buffer with that
            // tag inline would desync frames and not match the frame-quantized
            // byteLength the layout advertised. The frame table (getCbrSilenceFrameLengths)
            // is already ID3-free, so the stripped buffer and the byte map agree.
            const raw = await getCbrSilenceSecond().catch(() => Buffer.alloc(0));
            silenceUnit = raw.length > 0 ? stripId3Tag(Buffer.from(raw)) : raw;
          }
          const remaining = byteCount - written;
          let chunk: Buffer;
          if (silenceUnit.length > 0) {
            chunk = remaining >= silenceUnit.length ? silenceUnit : silenceUnit.subarray(0, remaining);
          } else {
            chunk = Buffer.alloc(Math.min(remaining, 65536)); // ffmpeg unavailable fallback
          }
          yield chunk;
          written += chunk.length;
        }
      };

      try {
        for (; slotIdx < mapLayout.slots.length && sent < need; slotIdx += 1) {
          const slot = mapLayout.slots[slotIdx];
          const ordinal = slot.ordinal;
          let audioKey: string | null = null;
          let paddedMissingPrefix = false;
          let paddedErrorSegment = false;
          for (;;) {
            if (closed) return;
            const session = await readModel.readSession(sessionId);
            if (!session || Date.now() > session.expiresAt) return;
            if (session.status !== 'queued' && session.status !== 'running' && session.status !== 'succeeded') {
              return;
            }
            const segmentState = await readModel.readSegmentState(session, ordinal);
            if (segmentState.status === 'completed') {
              audioKey = segmentState.audioKey;
              break;
            }
            if (segmentState.status === 'error') {
              const room = need - sent;
              const silenceBytes = Math.max(0, Math.min(room, slot.byteLength - skipWithin));
              if (silenceBytes > 0) {
                for await (const chunk of streamSilence(silenceBytes)) {
                  yield chunk;
                  sent += chunk.length;
                }
              }
              skipWithin = 0;
              paddedErrorSegment = true;
              app.log.info({ sessionId, ordinal }, 'tts.playback.audio.skipped_error_segment');
              await controller.updateCursor(sessionId, ordinal).catch((error) => {
                app.log.warn({ sessionId, ordinal, error: toErrorMessage(error) }, 'tts.playback.cursor_update_failed');
              });
              break;
            }
            // Scaffolding silence for the never-generated prefix below the current
            // generation floor. The floor is shared with the worker's generation
            // lower bound via generationFloorForCursor (so the two can never drift
            // -> no `bytes=0-` probe hang). A seek request (rangeStartOrdinal > 0)
            // pins the floor to its own start — race-proof, since it never serves
            // ordinals below that anyway — so a backward seek waits for real audio
            // at the target instead of being silenced by a stale higher cursor. The
            // `bytes=0-` probe (rangeStartOrdinal === 0) uses the live cursor so a
            // deep start still emits silence for [0, cursor) and completes at once.
            const silenceFloor = generationFloorForCursor(
              rangeStartOrdinal > 0 ? rangeStartOrdinal : session.cursorOrdinal,
            );
            if (ordinal < silenceFloor) {
              // Emit the slot's whole-frame silence so it decodes to exactly its
              // grid duration.
              const room = need - sent;
              const silenceBytes = Math.max(0, Math.min(room, slot.byteLength - skipWithin));
              if (silenceBytes > 0) {
                for await (const chunk of streamSilence(silenceBytes)) {
                  yield chunk;
                  sent += chunk.length;
                }
              }
              skipWithin = 0;
              paddedMissingPrefix = true;
              break;
            }
            if (session.status === 'succeeded') {
              // Generation finished but this ordinal has no audio (gap / end of the
              // generated extent): stop pulling real audio and pad the rest.
              app.log.info({ sessionId, ordinal }, 'tts.playback.audio.stopped_at_gap');
              break;
            }
            // Still generating (status running): wait for this segment to finish.
            // Forward playback self-paces — generation stays ahead of the cursor (which
            // we advance as we serve), so the segment is on its way. A seek past the
            // frontier issues a new range request and updates the cursor, so generation
            // jumps there; we wait (brief buffering) rather than silencing the rest of
            // the response, which the browser would never re-request.
            //
            // Re-anchor generation to the ordinal we're blocked on: this drives the
            // cursor here and (re)enqueues a continuation. After a forward seek the
            // prior run abandons the skipped gap (its onBeforeSegment floor check),
            // and this re-anchor starts a fresh run AT the target the moment that run
            // frees — so re-centering is prompt instead of waiting for the heartbeat.
            await controller.updateCursor(sessionId, ordinal).catch((error) => {
              app.log.warn({ sessionId, ordinal, error: toErrorMessage(error) }, 'tts.playback.cursor_reanchor_failed');
            });
            markActivity('tts_playback_audio_wait');
            await sleep(400);
          }
          if (!audioKey) {
            if (paddedMissingPrefix || paddedErrorSegment) continue;
            break;
          }

          await controller.updateCursor(sessionId, ordinal).catch((error) => {
            app.log.warn({ sessionId, ordinal, error: toErrorMessage(error) }, 'tts.playback.cursor_update_failed');
          });
          // Serve the segment's real CBR audio gaplessly — each segment is a whole
          // number of MP3 frames, so concatenation keeps the stream byte↔time linear
          // (and live highlighting accurate). NEVER pad/trim mid-segment: a mid-frame
          // cut drops a partial frame on decode, so playback runs slightly ahead of
          // the byte grid and the highlight drifts behind, accumulating per segment.
          let rawAudio: ArrayBuffer;
          try {
            rawAudio = await storage.readObject(audioKey);
          } catch (error) {
            if (!isMissingObjectError(error)) throw error;
            const session = await readModel.readSession(sessionId);
            if (session) await readModel.forgetCachedSidecar(session, ordinal);
            app.log.warn({
              sessionId,
              ordinal,
              audioKey,
              error: toErrorMessage(error),
            }, 'tts.playback.audio.stale_sidecar_missing_audio');
            await controller.updateCursor(sessionId, ordinal).catch((cursorError) => {
              app.log.warn({ sessionId, ordinal, error: toErrorMessage(cursorError) }, 'tts.playback.cursor_reanchor_failed');
            });
            markActivity('tts_playback_audio_wait_missing_audio');
            await sleep(400);
            slotIdx -= 1;
            continue;
          }
          let bytes = stripId3Tag(Buffer.from(rawAudio));
          if (skipWithin > 0) {
            bytes = bytes.subarray(Math.min(skipWithin, bytes.length));
            skipWithin = 0;
          }
          const room = need - sent;
          if (bytes.length > room) bytes = bytes.subarray(0, room);
          if (bytes.length > 0) {
            if (!wroteFirstByte) {
              wroteFirstByte = true;
              app.log.info({ sessionId, ordinal, firstByteMs: Date.now() - startedAt }, 'tts.playback.audio.first_byte');
            }
            markActivity('tts_playback_audio_segment');
            yield bytes;
            sent += bytes.length;
          }
        }

        // Pad up to the advertised length with valid CBR silence — streamed in bounded
        // chunks (reusing the cached ~1s buffer). The pad can be large for a long
        // document (the advertised total is a whole-document estimate), so it must
        // never be materialized as a single buffer.
        if (sent < need && !closed) {
          for await (const chunk of streamSilence(need - sent)) {
            yield chunk;
            sent += chunk.length;
          }
        }
      } catch (error) {
        if (closed || errorCode(error) === 'ERR_STREAM_PREMATURE_CLOSE') {
          app.log.info({ sessionId, sent, need, rangeStart: range.start, rangeEnd: range.end }, 'tts.playback.audio.stream_closed');
          return;
        }
        app.log.error({
          sessionId,
          sent,
          need,
          rangeStart: range.start,
          rangeEnd: range.end,
          slotIdx,
          error: toErrorMessage(error),
          code: errorCode(error),
        }, 'tts.playback.audio.stream_error');
        throw error;
      }
    };

    return Readable.from(streamRange());
  });
}
