import { requestJson } from '@/lib/client/api/http';
import type { TtsPlaybackPlanPayload } from '@/lib/client/api/tts';

export type DocumentStorageUsage = {
  currentAudioBytes: number;
  unusedAudioBytes: number;
  documentDataBytes: number;
  truncated: boolean;
};

export type LibraryStorageUsage = {
  audioBytes: number;
  orphanedAudioBytes: number;
  orphanedDocumentCount: number;
  documentDataBytes: number;
  documentCount: number;
  truncated: boolean;
};

export type DocumentAudioReclaimResult = {
  reclaimedVariants: number;
  deletedAudioObjects: number;
  deletedSidecarObjects: number;
  deletedExportObjects: number;
};

export type DocumentAudioDeleteResult = {
  deletedPlaybackObjects: number;
  invalidatedPlaybackSessions: number;
};

export type LibraryAudioReclaimTarget = 'orphaned' | 'all';

// Destructive storage requests wait for the worker to confirm deletion. The
// server gives the worker 45 seconds; the browser waits a little longer.
const STORAGE_REQUEST_TIMEOUT_MS = 60_000;
// One library reclaim request handles a bounded batch of documents.
const LIBRARY_RECLAIM_MAX_BATCHES = 200;

function jsonPost(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
  };
}

export function fetchDocumentStorageUsage(
  payload: TtsPlaybackPlanPayload,
  signal?: AbortSignal,
): Promise<DocumentStorageUsage> {
  return requestJson('/api/tts/storage/document', jsonPost(payload, signal), 'Failed to load storage usage');
}

export function reclaimUnusedDocumentAudio(payload: TtsPlaybackPlanPayload): Promise<DocumentAudioReclaimResult> {
  return requestJson('/api/tts/storage/document/reclaim', jsonPost(payload), 'Failed to reclaim unused audio');
}

export function deleteDocumentAudio(documentId: string): Promise<DocumentAudioDeleteResult> {
  return requestJson('/api/tts/segments/clear', jsonPost({ documentId }), 'Failed to delete audio');
}

export function fetchLibraryStorageUsage(signal?: AbortSignal): Promise<LibraryStorageUsage> {
  return requestJson('/api/tts/storage', { cache: 'no-store', signal }, 'Failed to load storage usage');
}

/** Repeat bounded server batches until every targeted document is handled. */
export async function reclaimLibraryAudio(target: LibraryAudioReclaimTarget): Promise<{ reclaimedDocuments: number }> {
  let reclaimedDocuments = 0;
  for (let batch = 0; batch < LIBRARY_RECLAIM_MAX_BATCHES; batch += 1) {
    const result = await requestJson<{ reclaimedDocuments: number; remainingDocuments: number }>(
      '/api/tts/storage/reclaim',
      jsonPost({ target }),
      'Failed to delete audio',
    );
    reclaimedDocuments += result.reclaimedDocuments;
    if (result.remainingDocuments === 0 || result.reclaimedDocuments === 0) break;
  }
  return { reclaimedDocuments };
}
