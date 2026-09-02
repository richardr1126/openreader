import { describe, expect, test } from 'vitest';
import { queryKeys } from '../../src/lib/client/query-keys';

describe('query keys', () => {
  test('isolates server state by session and document', () => {
    expect(queryKeys.documents('user-a')).not.toEqual(queryKeys.documents('user-b'));
    expect(queryKeys.libraryDocuments('user-a')).not.toEqual(queryKeys.libraryDocuments('user-b'));
    expect(queryKeys.readerBootstrap('user-a', 'doc-a')).not.toEqual(queryKeys.readerBootstrap('user-a', 'doc-b'));
    expect(queryKeys.readerBootstrap('user-a', 'doc-a')).not.toEqual(queryKeys.readerBootstrap('user-b', 'doc-a'));
    expect(queryKeys.readerDocumentSource('user-a', 'doc-a', 'v1'))
      .not.toEqual(queryKeys.readerDocumentSource('user-a', 'doc-a', 'v2'));
    expect(queryKeys.readerDocumentSource('user-a', 'doc-a', 'v1'))
      .not.toEqual(queryKeys.readerDocumentSource('user-b', 'doc-a', 'v1'));
  });

  test('defines centralized keys for migrated server-state domains', () => {
    expect(queryKeys.readerBootstraps()).toEqual(['reader-bootstrap']);
    expect(queryKeys.preferences('user')).toEqual(['preferences', 'user']);
    expect(queryKeys.onboarding('user')).toEqual(['onboarding', 'user']);
    expect(queryKeys.folders('user')).toEqual(['folders', 'user']);
    expect(queryKeys.sharedProviders('user')).toEqual(['tts-shared-providers', 'user']);
    expect(queryKeys.ttsVoices('user', 'shared', 'model')).toEqual(['tts-voices', 'user', 'shared', 'model']);
    expect(queryKeys.claimCounts('user')).toEqual(['claim-counts', 'user']);
    expect(queryKeys.rateLimit('user')).toEqual(['rate-limit', 'user']);
    expect(queryKeys.admin('user', 'settings')).toEqual(['admin', 'user', 'settings']);
  });

  test('keys public changelog content by url rather than session', () => {
    expect(queryKeys.changelogManifest('https://x/manifest.json')).toEqual(['changelog', 'manifest', 'https://x/manifest.json']);
    expect(queryKeys.changelogReleaseBody('https://x/manifest.json', 'bodies/v1.json')).toEqual(['changelog', 'body', 'https://x/manifest.json', 'bodies/v1.json']);
  });
});
