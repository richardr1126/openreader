import { describe, expect, test } from 'vitest';
import {
  releaseWarmAudio,
  upsertWarmAudioEntry,
  type WarmAudioCacheEntry,
  type WarmAudioLike,
} from '../../src/lib/client/tts/audio-warm-cache';

function createTrackedAudio() {
  const calls = {
    pause: 0,
    removeAttribute: 0,
    load: 0,
  };
  const audio: WarmAudioLike = {
    pause: () => { calls.pause += 1; },
    removeAttribute: (name: string) => {
      if (name === 'src') calls.removeAttribute += 1;
    },
    load: () => { calls.load += 1; },
    src: 'https://audio.example/current.mp3',
  };
  return { audio, calls };
}

describe('tts warm audio cache helpers', () => {
  test('releaseWarmAudio clears source and invokes teardown methods', () => {
    const tracked = createTrackedAudio();
    releaseWarmAudio(tracked.audio);
    expect(tracked.calls.pause).toBe(1);
    expect(tracked.calls.removeAttribute).toBe(1);
    expect(tracked.calls.load).toBe(1);
  });

  test('upsertWarmAudioEntry keeps existing entry when key and url match', () => {
    const cache = new Map<string, WarmAudioCacheEntry>();
    const firstAudio = createTrackedAudio();
    const first = upsertWarmAudioEntry({
      key: 'a',
      url: 'https://audio.example/a.mp3',
      cache,
      maxEntries: 3,
      createAudio: () => firstAudio.audio,
      nowMs: 100,
    });
    const second = upsertWarmAudioEntry({
      key: 'a',
      url: 'https://audio.example/a.mp3',
      cache,
      maxEntries: 3,
      createAudio: () => createTrackedAudio().audio,
      nowMs: 200,
    });

    expect(second).toBe(first);
    expect(second.warmedAt).toBe(200);
    expect(cache.size).toBe(1);
  });

  test('upsertWarmAudioEntry replaces changed url and releases prior audio', () => {
    const cache = new Map<string, WarmAudioCacheEntry>();
    const oldAudio = createTrackedAudio();
    const nextAudio = createTrackedAudio();

    upsertWarmAudioEntry({
      key: 'a',
      url: 'https://audio.example/a-1.mp3',
      cache,
      maxEntries: 3,
      createAudio: () => oldAudio.audio,
      nowMs: 100,
    });

    upsertWarmAudioEntry({
      key: 'a',
      url: 'https://audio.example/a-2.mp3',
      cache,
      maxEntries: 3,
      createAudio: () => nextAudio.audio,
      nowMs: 120,
    });

    expect(oldAudio.calls.pause).toBe(1);
    expect(oldAudio.calls.removeAttribute).toBe(1);
    expect(oldAudio.calls.load).toBe(1);
    expect(cache.get('a')?.url).toBe('https://audio.example/a-2.mp3');
  });

  test('upsertWarmAudioEntry evicts least-recently-warmed entry when cache is full', () => {
    const cache = new Map<string, WarmAudioCacheEntry>();
    const a = createTrackedAudio();
    const b = createTrackedAudio();
    const c = createTrackedAudio();

    upsertWarmAudioEntry({
      key: 'a',
      url: 'https://audio.example/a.mp3',
      cache,
      maxEntries: 2,
      createAudio: () => a.audio,
      nowMs: 100,
    });
    upsertWarmAudioEntry({
      key: 'b',
      url: 'https://audio.example/b.mp3',
      cache,
      maxEntries: 2,
      createAudio: () => b.audio,
      nowMs: 200,
    });
    upsertWarmAudioEntry({
      key: 'c',
      url: 'https://audio.example/c.mp3',
      cache,
      maxEntries: 2,
      createAudio: () => c.audio,
      nowMs: 300,
    });

    expect(cache.has('a')).toBeFalsy();
    expect(cache.has('b')).toBeTruthy();
    expect(cache.has('c')).toBeTruthy();
    expect(a.calls.pause).toBe(1);
    expect(a.calls.removeAttribute).toBe(1);
    expect(a.calls.load).toBe(1);
  });
});
