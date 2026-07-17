import { describe, expect, test } from 'vitest';
import { createJobHandlers } from '../../src/jobs/handlers';
import {
  buildExportChapters,
  buildExportFilename,
  contentTypeForExportFormat,
  stripId3Tag,
} from '../../src/jobs/playback/ffmpeg-export';
import { classifySegmentError } from '../../src/jobs/playback/segment-generation';

describe('worker job composition', () => {
  test('composes the exhaustive worker-loop handler surface', () => {
    const handlers = createJobHandlers({} as never);
    expect(Object.keys(handlers)).toEqual([
      'runPdfLayout',
      'runTtsPlayback',
      'runTtsPlaybackPlan',
      'runTtsPlaybackExportArtifact',
      'runDocumentPreview',
      'runDocumentConversion',
      'runAccountExport',
    ]);
    expect(Object.values(handlers).every((handler) => typeof handler === 'function')).toBe(true);
  });
});

describe('TTS playback segment retry classification', () => {
  test('preserves rate-limit details and retries transient upstream errors', () => {
    const rateLimit = Object.assign(new Error('slow down'), {
      response: { status: 429, headers: { 'retry-after': '7' } },
    });
    expect(classifySegmentError(rateLimit)).toEqual({
      info: {
        message: 'slow down',
        code: 'UPSTREAM_RATE_LIMIT',
        upstreamStatus: 429,
        retryAfterSeconds: 7,
      },
      retryable: true,
    });
    expect(classifySegmentError(Object.assign(new Error('unavailable'), { status: 503 })).retryable).toBe(true);
  });

  test('does not retry provider client errors', () => {
    expect(classifySegmentError(Object.assign(new Error('bad voice'), { statusCode: 400 }))).toEqual({
      info: { message: 'bad voice', code: 'UPSTREAM_ERROR', upstreamStatus: 400 },
      retryable: false,
    });
  });
});

describe('TTS playback export assembly', () => {
  test('builds speed-adjusted chapters from locator groups', () => {
    const chapters = buildExportChapters({
      segments: [
        { ordinal: 0, text: 'One.', locator: { readerType: 'pdf', page: 1 } },
        { ordinal: 1, text: 'Two.', locator: { readerType: 'pdf', page: 1 } },
        { ordinal: 2, text: 'Three.', locator: { readerType: 'pdf', page: 2 } },
      ],
      durationsByOrdinal: new Map([[0, 1_000], [1, 1_000], [2, 2_000]]),
      speed: 2,
    });
    expect(chapters).toEqual([
      { title: 'Page 1', startMs: 0, endMs: 1_000 },
      { title: 'Page 2', startMs: 1_000, endMs: 2_000 },
    ]);
  });

  test('normalizes filenames, content types, and leading ID3 tags', () => {
    expect(buildExportFilename({ documentId: 'abcdef1234567890', speed: 1.5, format: 'm4b' }))
      .toBe('openreader-abcdef123456-1.5x.m4b');
    expect(contentTypeForExportFormat('m4b')).toBe('audio/mp4');
    expect(contentTypeForExportFormat('mp3')).toBe('audio/mpeg');

    const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3]);
    const audio = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
    expect(stripId3Tag(Buffer.concat([header, Buffer.from('tag'), audio]))).toEqual(audio);
  });
});
