import { describe, expect, test } from 'vitest';
import type { Archiver } from 'archiver';
import { appendUserExportArchive } from '../../src/lib/server/user/data-export';

describe('user data export archive', () => {
  test('includes user metadata and cached TTS audio without credential secrets', async () => {
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
      audiobooks: [],
      audiobookChapters: [],
      ttsSegmentEntries: [{ segmentEntryId: 'entry-1', documentId: 'doc-1' }],
      ttsSegmentVariants: [{
        segmentId: 'segment-1',
        segmentEntryId: 'entry-1',
        audioKey: 'private/audio/key',
        audioFormat: 'mp3',
      }],
      getDocumentBlobStream: async () => new Uint8Array(),
      listAudiobookObjects: async () => [],
      getAudiobookObjectStream: async () => new Uint8Array(),
      getTtsSegmentAudioStream: async () => new Uint8Array([1, 2, 3]),
    });

    expect(entries.has('document_settings.json')).toBe(true);
    expect(entries.has('auth_sessions.json')).toBe(true);
    expect(entries.has('linked_accounts.json')).toBe(true);
    expect(entries.has('tts_segment_entries.json')).toBe(true);
    expect(entries.has('tts_segment_variants.json')).toBe(true);
    expect(entries.has('files/tts_segments/doc-1/segment-1.mp3')).toBe(true);

    const manifest = JSON.parse(String(entries.get('export_manifest.json')));
    expect(manifest).toMatchObject({
      formatVersion: 3,
      counts: {
        ttsSegmentEntriesMetadata: 1,
        ttsSegmentVariantsMetadata: 1,
        ttsSegmentFiles: 1,
      },
      includes: {
        credentialSecrets: false,
      },
    });
  });
});
