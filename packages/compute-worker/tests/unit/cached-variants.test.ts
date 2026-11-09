import { describe, expect, test } from 'vitest';
import { STREAM_AUDIO_BYTES_PER_SECOND } from '@openreader/tts/audio-format';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { listCachedPlaybackVariants } from '../../src/storage/cached-variants';
import { storageUserHash } from '../../src/storage/prefix-cleanup';

type Stored = { body: Buffer; lastModifiedMs: number };

function memoryStorage(objects: Map<string, Stored>): ArtifactStorage {
  const keys = (prefix: string) => [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
  return {
    readObject: async (key: string) => {
      const body = objects.get(key)!.body;
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    },
    async *listPrefixPages(prefix: string) {
      yield keys(prefix).map(key => ({ key, size: objects.get(key)!.body.length, lastModifiedMs: objects.get(key)!.lastModifiedMs }));
    },
    listChildPrefixes: async (prefix: string) => [...new Set(keys(prefix).map(key => key.slice(prefix.length).split('/')[0]))],
  } as unknown as ArtifactStorage;
}

describe('cached playback variants', () => {
  test('reports each cached setting with its segment count, length and settings', async () => {
    const audio = 'p/tts_playback_segments_audio_v1/users/user%401/docs/doc/7/';
    const sidecars = `p/tts_playback_segments_v1/users/${storageUserHash('user@1')}/docs/doc/7/`;
    const settings = { providerRef: 'kitten', ttsModel: 'KittenTTS', voice: 'Luna', nativeSpeed: 1.2 };
    const objects = new Map<string, Stored>([
      [`${audio}older/a.mp3`, { body: Buffer.alloc(STREAM_AUDIO_BYTES_PER_SECOND), lastModifiedMs: 100 }],
      [`${audio}newer/a.mp3`, { body: Buffer.alloc(STREAM_AUDIO_BYTES_PER_SECOND * 2), lastModifiedMs: 300 }],
      [`${audio}newer/b.mp3`, { body: Buffer.alloc(STREAM_AUDIO_BYTES_PER_SECOND), lastModifiedMs: 200 }],
      // Audio whose settings record is gone can't be named, so it is left out.
      [`${audio}orphan/a.mp3`, { body: Buffer.alloc(10), lastModifiedMs: 400 }],
      [`${sidecars}newer/segments/0.json`, { body: Buffer.from(JSON.stringify({ settingsJson: JSON.stringify(settings) })), lastModifiedMs: 1 }],
      [`${sidecars}older/segments/0.json`, { body: Buffer.from(JSON.stringify({ settingsJson: { ...settings, nativeSpeed: 1 } })), lastModifiedMs: 1 }],
    ]);

    const variants = await listCachedPlaybackVariants({
      storage: memoryStorage(objects), s3Prefix: 'p', storageUserId: 'user@1', documentId: 'doc', documentVersion: 7,
    });

    expect(variants).toEqual([
      { settingsHash: 'newer', settingsJson: settings, segments: 2, durationMs: 3000, updatedAt: 300 },
      { settingsHash: 'older', settingsJson: { ...settings, nativeSpeed: 1 }, segments: 1, durationMs: 1000, updatedAt: 100 },
    ]);
  });
});
