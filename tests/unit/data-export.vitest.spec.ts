import { describe, expect, test, vi } from 'vitest';
import type { Archiver } from 'archiver';
import { appendUserExportArchive } from '../../src/lib/server/user/data-export';

describe('user data export archive', () => {
  test('includes user metadata without credential secrets or transient playback cache', async () => {
    const entries = new Map<string, unknown>();
    const archive = {
      append(value: unknown, options: { name: string }) {
        entries.set(options.name, value);
        return archive;
      },
    } as unknown as Archiver;

    await appendUserExportArchive({
      archive,
      userId: 'user-1',
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
      storageEnabled: true,
      getDocumentBlobStream: async () => new Uint8Array(),
    });

    expect(entries.has('document_settings.json')).toBe(true);
    expect(entries.has('auth_sessions.json')).toBe(true);
    expect(entries.has('linked_accounts.json')).toBe(true);
    expect(entries.has('tts_segment_entries.json')).toBe(false);
    expect(entries.has('tts_segment_variants.json')).toBe(false);

    const manifest = JSON.parse(String(entries.get('export_manifest.json')));
    expect(manifest).toMatchObject({
      formatVersion: 3,
      includes: {
        credentialSecrets: false,
      },
    });
    expect(manifest.includes).not.toHaveProperty('ttsSegmentFiles');
  });

  test('reports file buckets as excluded when storage is disabled', async () => {
    const entries = new Map<string, unknown>();
    const archive = {
      append(value: unknown, options: { name: string }) {
        entries.set(options.name, value);
        return archive;
      },
    } as unknown as Archiver;
    const getDocumentBlobStream = vi.fn(async () => new Uint8Array());

    await appendUserExportArchive({
      archive,
      userId: 'user-1',
      exportedAtMs: 123,
      profileData: {},
      preferences: null,
      readingHistory: [],
      ttsUsage: [],
      jobEvents: [],
      documentSettings: [],
      authSessions: [],
      linkedAccounts: [],
      documents: [{ id: 'doc-1', name: 'doc.pdf' }],
      storageEnabled: false,
      getDocumentBlobStream,
    });

    const manifest = JSON.parse(String(entries.get('export_manifest.json')));
    expect(manifest.includes).toMatchObject({
      documentFiles: false,
    });
    expect(manifest.counts).toMatchObject({
      documentFiles: 0,
    });
    expect(getDocumentBlobStream).not.toHaveBeenCalled();
  });
});
