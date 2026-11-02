import { describe, expect, test } from 'vitest';
import type { UserStorageUsageReport } from '@/lib/server/compute-worker/protocol';
import {
  summarizeDocumentStorage,
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

});
