import { describe, expect, test } from 'vitest';
import { queryKeys } from '../../src/lib/client/query-keys';

describe('query keys', () => {
  test('isolates server state by session and document', () => {
    expect(queryKeys.documents('user-a')).not.toEqual(queryKeys.documents('user-b'));
    expect(queryKeys.progress('user-a', 'doc-a')).not.toEqual(queryKeys.progress('user-a', 'doc-b'));
    expect(queryKeys.documentSettings('user-a', 'doc-a')).not.toEqual(queryKeys.documentSettings('user-b', 'doc-a'));
  });

  test('defines centralized keys for migrated server-state domains', () => {
    expect(queryKeys.preferences('user')).toEqual(['preferences', 'user']);
    expect(queryKeys.onboarding('user')).toEqual(['onboarding', 'user']);
    expect(queryKeys.folders('user')).toEqual(['folders', 'user']);
    expect(queryKeys.audiobook('user', 'book')).toEqual(['audiobook', 'user', 'book']);
    expect(queryKeys.ttsManifest('user', 'doc')).toEqual(['tts-manifest', 'user', 'doc']);
    expect(queryKeys.parsedDocument('user', 'doc')).toEqual(['parsed-document', 'user', 'doc']);
  });
});
