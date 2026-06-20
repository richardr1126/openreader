import { describe, expect, test } from 'vitest';
import { queryKeys } from '../../src/lib/client/query-keys';

describe('query keys', () => {
  test('isolates server state by session and document', () => {
    expect(queryKeys.documents('user-a')).not.toEqual(queryKeys.documents('user-b'));
    expect(queryKeys.libraryDocuments('user-a')).not.toEqual(queryKeys.libraryDocuments('user-b'));
    expect(queryKeys.progress('user-a', 'doc-a')).not.toEqual(queryKeys.progress('user-a', 'doc-b'));
    expect(queryKeys.documentSettings('user-a', 'doc-a')).not.toEqual(queryKeys.documentSettings('user-b', 'doc-a'));
  });

  test('defines centralized keys for migrated server-state domains', () => {
    expect(queryKeys.preferences('user')).toEqual(['preferences', 'user']);
    expect(queryKeys.onboarding('user')).toEqual(['onboarding', 'user']);
    expect(queryKeys.folders('user')).toEqual(['folders', 'user']);
    expect(queryKeys.audiobook('user', 'book')).toEqual(['audiobook', 'user', 'book']);
    expect(queryKeys.sharedProviders('user')).toEqual(['tts-shared-providers', 'user']);
    expect(queryKeys.ttsVoices('user', 'shared', 'model')).toEqual(['tts-voices', 'user', 'shared', 'model']);
    expect(queryKeys.ttsManifest('user', 'doc')).toEqual(['tts-manifest', 'user', 'doc', 'document']);
    expect(queryKeys.ttsManifest('user', 'doc', 'epub:2:OEBPS/ch02.xhtml')).toEqual([
      'tts-manifest',
      'user',
      'doc',
      'epub:2:OEBPS/ch02.xhtml',
    ]);
    expect(queryKeys.parsedDocument('user', 'doc')).toEqual(['parsed-document', 'user', 'doc']);
    expect(queryKeys.claimCounts('user')).toEqual(['claim-counts', 'user']);
    expect(queryKeys.rateLimit('user')).toEqual(['rate-limit', 'user']);
    expect(queryKeys.admin('user', 'settings')).toEqual(['admin', 'user', 'settings']);
  });

  test('keys public changelog content by url rather than session', () => {
    expect(queryKeys.changelogManifest('https://x/manifest.json')).toEqual(['changelog', 'manifest', 'https://x/manifest.json']);
    expect(queryKeys.changelogReleaseBody('https://x/manifest.json', 'bodies/v1.json')).toEqual(['changelog', 'body', 'https://x/manifest.json', 'bodies/v1.json']);
  });
});
