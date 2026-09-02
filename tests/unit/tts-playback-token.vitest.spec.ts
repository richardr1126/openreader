import { describe, expect, test } from 'vitest';
import {
  createTtsPlaybackToken,
  verifyTtsPlaybackToken,
} from '@openreader/tts/playback-token';

describe('TTS playback token', () => {
  test('round-trips a valid signed playback payload', () => {
    const payload = {
      sessionId: 'session-1',
      userId: 'user-1',
      storageUserId: 'storage-user-1',
      documentId: 'doc-1',
      exp: 2_000,
    };
    const token = createTtsPlaybackToken(payload, 'secret');
    expect(verifyTtsPlaybackToken(token, 'secret', { nowMs: 1_000 })).toEqual(payload);
  });

  test('rejects expired and incorrectly signed tokens', () => {
    const token = createTtsPlaybackToken({
      sessionId: 'session-1',
      userId: 'user-1',
      storageUserId: 'storage-user-1',
      documentId: 'doc-1',
      exp: 2_000,
    }, 'secret');

    expect(() => verifyTtsPlaybackToken(token, 'secret', { nowMs: 2_000 })).toThrow(/expired/i);
    expect(() => verifyTtsPlaybackToken(token, 'other-secret', { nowMs: 1_000 })).toThrow(/signature/i);
  });
});
