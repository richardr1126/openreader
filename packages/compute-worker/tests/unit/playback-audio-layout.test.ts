import { describe, expect, test } from 'vitest';
import {
  cumulativeCbrFrameBytes,
  MP3_FRAME_DURATION_MS,
  parseMp3FrameLengths,
  STREAM_AUDIO_BYTES_PER_SECOND,
} from '@openreader/tts/audio-format';
import {
  DEFAULT_MS_PER_CHAR,
  bytesForDurationMs,
  buildByteLayout,
  calibrateMsPerChar,
  estimateDurationMs,
  locateByte,
  parseRangeHeader,
  resolvePlaybackStreamStartOrdinal,
  type PlanSlotInput,
} from '../../src/api/playback-audio-layout';

describe('resolvePlaybackStreamStartOrdinal', () => {
  const ordinals = [0, 1, 5, 9];

  test('defaults to the session start and accepts an explicit rebase', () => {
    expect(resolvePlaybackStreamStartOrdinal(ordinals, 5)).toBe(5);
    expect(resolvePlaybackStreamStartOrdinal(ordinals, 5, 1)).toBe(1);
  });

  test('rejects invalid or non-plan stream starts', () => {
    expect(resolvePlaybackStreamStartOrdinal(ordinals, 5, 6)).toBeNull();
    expect(resolvePlaybackStreamStartOrdinal(ordinals, 5, 'nope')).toBeNull();
  });
});

// 128 kbps CBR ⇒ 16000 bytes/sec.
const BPS = STREAM_AUDIO_BYTES_PER_SECOND;

describe('CBR byte/time linearity', () => {
  test('bytesForDurationMs is linear and rounds, clamps non-positive', () => {
    expect(BPS).toBe(16000);
    expect(bytesForDurationMs(1000)).toBe(16000);
    expect(bytesForDurationMs(500)).toBe(8000);
    expect(bytesForDurationMs(0)).toBe(0);
    expect(bytesForDurationMs(-5)).toBe(0);
    expect(bytesForDurationMs(Number.NaN)).toBe(0);
  });
});

describe('duration estimation + calibration', () => {
  test('estimateDurationMs scales with trimmed char count', () => {
    expect(estimateDurationMs('', 50)).toBe(1); // floored to 1ms, never 0
    expect(estimateDurationMs('  hello  ', 10)).toBe(50); // 5 chars * 10
    expect(estimateDurationMs('abcd', 0)).toBe(4 * DEFAULT_MS_PER_CHAR); // bad rate → default
  });

  test('calibrateMsPerChar averages real samples, falls back when empty', () => {
    expect(calibrateMsPerChar([])).toBe(DEFAULT_MS_PER_CHAR);
    expect(calibrateMsPerChar([{ chars: 0, durationMs: 0 }])).toBe(DEFAULT_MS_PER_CHAR);
    // 100 chars → 5000ms and 50 chars → 2500ms ⇒ 50 ms/char overall.
    expect(calibrateMsPerChar([
      { chars: 100, durationMs: 5000 },
      { chars: 50, durationMs: 2500 },
    ])).toBe(50);
  });
});

describe('buildByteLayout', () => {
  const plan: PlanSlotInput[] = [
    { ordinal: 0, text: 'aaaaa', durationMs: 1000 }, // generated → exact
    { ordinal: 1, text: 'bbbbb', durationMs: 2000 }, // generated → exact
    { ordinal: 2, text: 'ccccc', durationMs: null }, // pending → estimated
  ];

  test('windows from startOrdinal and sizes slots from exact/estimated duration', () => {
    const layout = buildByteLayout(plan, 1, 50);
    expect(layout.slots.map((s) => s.ordinal)).toEqual([1, 2]);
    // slot 1: exact 2000ms → 32000 bytes; slot 2: 5 chars * 50ms = 250ms → 4000 bytes
    expect(layout.slots[0]).toMatchObject({ startByte: 0, byteLength: 32000, generated: true });
    expect(layout.slots[1]).toMatchObject({ startByte: 32000, byteLength: 4000, generated: false });
    expect(layout.totalBytes).toBe(36000);
  });

  test('whole window from ordinal 0 is contiguous with no gaps', () => {
    const layout = buildByteLayout(plan, 0, 50);
    let cursor = 0;
    for (const slot of layout.slots) {
      expect(slot.startByte).toBe(cursor);
      cursor += slot.byteLength;
    }
    expect(layout.totalBytes).toBe(cursor);
  });
});

describe('locateByte', () => {
  const layout = buildByteLayout(
    [
      { ordinal: 0, text: 'x', durationMs: 1000 }, // [0, 16000)
      { ordinal: 1, text: 'x', durationMs: 1000 }, // [16000, 32000)
      { ordinal: 2, text: 'x', durationMs: 1000 }, // [32000, 48000)
    ],
    0,
    50,
  );

  test('maps interior offsets to the right slot + offset within', () => {
    expect(locateByte(layout, 0)).toEqual({ slotIndex: 0, offsetWithin: 0 });
    expect(locateByte(layout, 16000)).toEqual({ slotIndex: 1, offsetWithin: 0 });
    expect(locateByte(layout, 20000)).toEqual({ slotIndex: 1, offsetWithin: 4000 });
    expect(locateByte(layout, 47999)).toEqual({ slotIndex: 2, offsetWithin: 15999 });
  });

  test('returns null at/after the end and for negatives', () => {
    expect(locateByte(layout, 48000)).toBeNull();
    expect(locateByte(layout, -1)).toBeNull();
  });
});

describe('parseRangeHeader', () => {
  const total = 1000;

  test('no header → null (serve full 200)', () => {
    expect(parseRangeHeader(undefined, total)).toBeNull();
    expect(parseRangeHeader('', total)).toBeNull();
  });

  test('open-ended and closed single ranges clamp to total', () => {
    expect(parseRangeHeader('bytes=0-', total)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader('bytes=100-', total)).toEqual({ start: 100, end: 999 });
    expect(parseRangeHeader('bytes=100-199', total)).toEqual({ start: 100, end: 199 });
    expect(parseRangeHeader('bytes=100-5000', total)).toEqual({ start: 100, end: 999 });
  });

  test('suffix range returns the last N bytes', () => {
    expect(parseRangeHeader('bytes=-200', total)).toEqual({ start: 800, end: 999 });
    expect(parseRangeHeader('bytes=-5000', total)).toEqual({ start: 0, end: 999 });
  });

  test('beyond-resource start is unsatisfiable', () => {
    expect(parseRangeHeader('bytes=1000-', total)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=2000-3000', total)).toBe('unsatisfiable');
  });

  test('malformed / multi-range / inverted → invalid (caller serves full)', () => {
    expect(parseRangeHeader('bytes=abc-def', total)).toBe('invalid');
    expect(parseRangeHeader('bytes=0-10,20-30', total)).toBe('invalid');
    expect(parseRangeHeader('bytes=-', total)).toBe('invalid');
    expect(parseRangeHeader('bytes=500-100', total)).toBe('invalid');
    expect(parseRangeHeader('kb=0-100', total)).toBe('invalid');
  });

  test('unknown total size is unsatisfiable for any range', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
  });
});

// Build a synthetic MPEG-1 Layer III @ 128 kbps / 44.1 kHz frame: header declares
// length 417 (+1 when padded), rest is filler. Mirrors STREAM_AUDIO_PROFILE output.
function fakeMp3Frame(padding: 0 | 1): Buffer {
  const length = 417 + padding;
  const frame = Buffer.alloc(length);
  frame[0] = 0xff;
  frame[1] = 0xfb; // sync + MPEG-1 + Layer III
  frame[2] = 0x90 | (padding << 1); // bitrate idx 9 (128k), samplerate idx 0 (44.1k), padding bit
  frame[3] = 0x00;
  return frame;
}

describe('MP3 frame parsing + cumulative silence bytes', () => {
  test('parseMp3FrameLengths reads each frame length and skips an ID3v2 tag', () => {
    const frames = Buffer.concat([fakeMp3Frame(1), fakeMp3Frame(0), fakeMp3Frame(1)]);
    expect(parseMp3FrameLengths(frames)).toEqual([418, 417, 418]);

    // 10-byte ID3v2 header (size 0) prepended — must be skipped.
    const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(parseMp3FrameLengths(Buffer.concat([id3, frames]))).toEqual([418, 417, 418]);
  });

  test('cumulativeCbrFrameBytes sums whole frames, cycling the table', () => {
    const table = [418, 417, 418];
    expect(cumulativeCbrFrameBytes(table, 0)).toBe(0);
    expect(cumulativeCbrFrameBytes(table, 3)).toBe(1253); // one full cycle
    expect(cumulativeCbrFrameBytes(table, 5)).toBe(1253 + 418 + 417); // +2 frames
    expect(cumulativeCbrFrameBytes([], 5)).toBe(0); // no table → degrade to 0
  });
});

describe('buildByteLayout frame-quantized silence', () => {
  const frameMs = MP3_FRAME_DURATION_MS;
  const bytesForFrames = (frames: number) => frames * 418; // pretend every frame is 418 B

  test('silence slots snap to whole frames in both duration and bytes', () => {
    // 40 chars * 50 ms = 2000 ms estimate → a whole number of frames.
    const frames = Math.round(2000 / frameMs);
    const plan: PlanSlotInput[] = [{ ordinal: 0, text: 'x'.repeat(40), durationMs: null }];
    const layout = buildByteLayout(plan, 0, 50, {
      frameDurationMs: frameMs,
      silenceBytesForFrames: bytesForFrames,
    });
    expect(layout.slots[0]).toMatchObject({
      durationMs: Math.max(1, Math.round(frames * frameMs)),
      byteLength: bytesForFrames(frames),
      generated: false,
      estimated: true,
    });
  });

  test('generated slots keep their real duration; silence falls back to CBR bytes without a resolver', () => {
    const plan: PlanSlotInput[] = [
      { ordinal: 0, text: 'a', durationMs: 1000 }, // generated
      { ordinal: 1, text: 'bbbb', durationMs: null }, // silence
    ];
    const layout = buildByteLayout(plan, 0, 50, { frameDurationMs: frameMs });
    // generated slot untouched by quantization
    expect(layout.slots[0]).toMatchObject({ durationMs: 1000, byteLength: 16000, generated: true });
    // silence quantized in time; byteLength uses the linear CBR fallback (no resolver)
    const frames = Math.round((4 * 50) / frameMs);
    expect(layout.slots[1].durationMs).toBe(Math.max(1, Math.round(frames * frameMs)));
    expect(layout.slots[1].estimated).toBe(true);
  });
});
