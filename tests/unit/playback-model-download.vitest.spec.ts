import { describe, expect, it } from 'vitest';

import type { TtsPlaybackEventSnapshot } from '@/lib/client/api/tts';
import { describeModelDownload } from '@/lib/client/tts/model-download';

const MB = 1024 * 1024;

function snapshot(overrides: Partial<TtsPlaybackEventSnapshot>): TtsPlaybackEventSnapshot {
  return {
    status: 'running',
    completedThroughOrdinal: 3,
    completedCount: 4,
    skippedCount: 0,
    plannedCount: 40,
    phase: 'downloading_model',
    stopReason: null,
    downloadedBytes: 50 * MB,
    totalBytes: 200 * MB,
    modelComponents: null,
    ...overrides,
  };
}

describe('describeModelDownload', () => {
  it('shows word timing progress from a running download snapshot', () => {
    expect(describeModelDownload(snapshot({}))).toEqual({
      label: 'Downloading word timing model',
      statusMessage: '50.0 MB of 200.0 MB',
      progress: 25,
    });
  });

  it('names the voice download when the snapshot reports model parts', () => {
    const download = describeModelDownload(snapshot({
      modelComponents: [{ name: 'Model', totalBytes: 200 * MB, downloadedBytes: 50 * MB, state: 'downloading' }],
    }));
    expect(download?.label).toBe('Downloading voices');
  });

  it('hides once the download completes, the phase moves on, or the operation ends', () => {
    expect(describeModelDownload(snapshot({ downloadedBytes: 200 * MB }))).toBeNull();
    expect(describeModelDownload(snapshot({ phase: 'generating' }))).toBeNull();
    expect(describeModelDownload(snapshot({ status: 'succeeded' }))).toBeNull();
    expect(describeModelDownload(snapshot({ status: 'failed' }))).toBeNull();
  });

  it('shows an indeterminate popup before the size is known', () => {
    expect(describeModelDownload(snapshot({ downloadedBytes: null, totalBytes: null }))).toEqual({
      label: 'Downloading word timing model',
      statusMessage: 'Starting…',
      progress: null,
    });
  });
});
