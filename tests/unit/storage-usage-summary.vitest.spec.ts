import { describe, expect, test } from 'vitest';
import type { UserStorageUsageReport } from '@/lib/server/compute-worker/protocol';
import {
  orphanedAudioDocumentIds,
  summarizeDocumentStorage,
  summarizeLibraryStorage,
} from '@/lib/server/tts/storage-usage';

type DocumentRow = UserStorageUsageReport['documents'][number];

function document(documentId: string, overrides: Partial<DocumentRow> = {}): DocumentRow {
  return { documentId, variants: [], exports: [], derivedBytes: 0, derivedObjects: 0, ...overrides };
}

function report(documents: DocumentRow[], truncated = false): UserStorageUsageReport {
  return { documents, scannedObjects: documents.length, truncated };
}

describe('storage usage summaries', () => {
  test('splits document audio by the current version and settings hash', () => {
    const usage = report([document('doc-1', {
      variants: [
        { documentVersion: 2, settingsHash: 'current', bytes: 100, objects: 2 },
        { documentVersion: 2, settingsHash: 'other-voice', bytes: 40, objects: 1 },
        { documentVersion: 1, settingsHash: 'current', bytes: 30, objects: 1 },
      ],
      exports: [
        { documentVersion: 2, settingsHash: 'current', bytes: 7, objects: 1 },
        { documentVersion: 1, settingsHash: 'old', bytes: 5, objects: 1 },
        // Unattributed exports are never reclaimed, so they count as current.
        { documentVersion: null, settingsHash: null, bytes: 3, objects: 1 },
      ],
      derivedBytes: 900,
      derivedObjects: 4,
    })], true);

    expect(summarizeDocumentStorage(usage, { documentId: 'doc-1', documentVersion: 2, settingsHash: 'current' }))
      .toEqual({ currentAudioBytes: 110, unusedAudioBytes: 75, documentDataBytes: 900, truncated: true });
  });

  test('reports zero for a document with no stored objects', () => {
    expect(summarizeDocumentStorage(report([]), { documentId: 'doc-1', documentVersion: 1, settingsHash: 'h' }))
      .toEqual({ currentAudioBytes: 0, unusedAudioBytes: 0, documentDataBytes: 0, truncated: false });
  });

  test('totals library audio and attributes orphaned audio to removed documents', () => {
    const owned = new Set(['kept']);
    const playback = report([
      document('kept', { variants: [{ documentVersion: 1, settingsHash: 'a', bytes: 50, objects: 1 }] }),
      document('removed', {
        variants: [{ documentVersion: 1, settingsHash: 'a', bytes: 20, objects: 1 }],
        exports: [{ documentVersion: 1, settingsHash: 'a', bytes: 5, objects: 1 }],
      }),
      document('removed-empty'),
    ]);
    const derived = report([document('kept', { derivedBytes: 300, derivedObjects: 3 })]);

    expect(orphanedAudioDocumentIds(playback, owned)).toEqual(['removed']);
    expect(summarizeLibraryStorage([playback, derived], owned, { derivedTruncated: false })).toEqual({
      audioBytes: 75,
      orphanedAudioBytes: 25,
      orphanedDocumentCount: 1,
      documentDataBytes: 300,
      truncated: false,
    });
    expect(summarizeLibraryStorage([playback], owned, { derivedTruncated: true }).truncated).toBe(true);
    expect(summarizeLibraryStorage([report([], true)], owned, { derivedTruncated: false }).truncated).toBe(true);
  });
});
