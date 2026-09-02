import { describe, expect, test, vi } from 'vitest';
import { buildUserExportManifest } from '../../src/lib/server/user/data-export';

describe('user data export manifest', () => {
  test('includes user metadata without credential secrets or transient playback cache', () => {
    const manifest = buildUserExportManifest({
      userId: 'user-1',
      storageUserId: 'user-1',
      namespace: null,
      exportedAtMs: 123,
      profileData: { user: { id: 'user-1', email: 'person@example.com' }, exportedAtMs: 123 },
      preferences: { dataJson: '{}' },
      readingHistory: [{ documentId: 'doc-1' }],
      ttsUsage: [{ charCount: 10 }],
      jobEvents: [{ action: 'pdf-layout' }],
      documentSettings: [{ documentId: 'doc-1', dataJson: '{}' }],
      authSessions: [{ id: 'session-1', ipAddress: null }],
      linkedAccounts: [{ id: 'account-1', providerId: 'credential' }],
      documents: [],
      getDocumentObjectKey: () => 'openreader/documents_v1/doc-1',
    });

    expect(manifest.entries.documentSettings).toHaveLength(1);
    expect(manifest.entries.authSessions).toHaveLength(1);
    expect(manifest.entries.linkedAccounts).toHaveLength(1);
    expect(manifest.entries).not.toHaveProperty('ttsSegmentEntries');
    expect(manifest.entries).not.toHaveProperty('ttsSegmentVariants');
    expect(manifest.includes).toMatchObject({
      credentialSecrets: false,
      documentFiles: true,
    });
    expect(manifest.includes).not.toHaveProperty('ttsSegmentFiles');
  });

  test('records document object keys for worker-owned ZIP assembly', () => {
    const getDocumentObjectKey = vi.fn((documentId: string) => `openreader/documents_v1/${documentId}`);

    const manifest = buildUserExportManifest({
      userId: 'user-1',
      storageUserId: 'user-1',
      namespace: 'test-ns',
      exportedAtMs: 123,
      profileData: {},
      preferences: null,
      readingHistory: [],
      ttsUsage: [],
      jobEvents: [],
      documentSettings: [],
      authSessions: [],
      linkedAccounts: [],
      documents: [{ id: 'doc/1', name: '../unsafe.pdf' }],
      getDocumentObjectKey,
    });

    expect(manifest.files).toEqual([{
      documentId: 'doc/1',
      objectKey: 'openreader/documents_v1/doc/1',
      entryName: 'files/documents/doc_1/__unsafe.pdf',
    }]);
    expect(getDocumentObjectKey).toHaveBeenCalledWith('doc/1');
  });
});
