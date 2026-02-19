import { SYNCED_PREFERENCE_KEYS, type DocumentProgressRecord, type ReaderType, type SyncedPreferencesPatch } from '@/types/user-state';

type PreferencesResponse = {
  preferences: SyncedPreferencesPatch;
  clientUpdatedAtMs: number;
  hasStoredPreferences?: boolean;
};

type ProgressResponse = {
  progress: DocumentProgressRecord | null;
};

function sanitizePreferencesPatch(input: SyncedPreferencesPatch): SyncedPreferencesPatch {
  const patch: SyncedPreferencesPatch = {};
  for (const key of SYNCED_PREFERENCE_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === undefined) continue;
    (patch as Record<string, unknown>)[key] = value;
  }
  return patch;
}

export async function getUserPreferences(options?: { signal?: AbortSignal }): Promise<PreferencesResponse> {
  const res = await fetch('/api/user/state/preferences', { signal: options?.signal });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to load user preferences');
  }
  return (await res.json()) as PreferencesResponse;
}

export async function putUserPreferences(
  patch: SyncedPreferencesPatch,
  options?: { signal?: AbortSignal; clientUpdatedAtMs?: number },
): Promise<PreferencesResponse & { applied: boolean }> {
  const cleanPatch = sanitizePreferencesPatch(patch);
  const res = await fetch('/api/user/state/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patch: cleanPatch,
      clientUpdatedAtMs: options?.clientUpdatedAtMs ?? Date.now(),
    }),
    signal: options?.signal,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to update user preferences');
  }

  return (await res.json()) as PreferencesResponse & { applied: boolean };
}

type PendingPreferenceSync = {
  patch: SyncedPreferencesPatch;
  timer: ReturnType<typeof setTimeout> | null;
  sessionId: string | null;
};

const pendingPreferenceSync: PendingPreferenceSync = {
  patch: {},
  timer: null,
  sessionId: null,
};

let activeSyncController: AbortController | null = null;

/**
 * Cancel any pending debounced preference sync and abort in-flight requests.
 * Call this on session change / sign-out to prevent cross-account writes.
 */
export function cancelPendingPreferenceSync(): void {
  if (pendingPreferenceSync.timer) {
    clearTimeout(pendingPreferenceSync.timer);
    pendingPreferenceSync.timer = null;
  }
  pendingPreferenceSync.patch = {};
  pendingPreferenceSync.sessionId = null;

  if (activeSyncController) {
    activeSyncController.abort();
    activeSyncController = null;
  }
}

export function scheduleUserPreferencesSync(
  patch: SyncedPreferencesPatch,
  sessionId: string,
  debounceMs: number = 600,
): void {
  Object.assign(pendingPreferenceSync.patch, sanitizePreferencesPatch(patch));
  pendingPreferenceSync.sessionId = sessionId;

  if (pendingPreferenceSync.timer) {
    clearTimeout(pendingPreferenceSync.timer);
  }

  const capturedSessionId = sessionId;

  pendingPreferenceSync.timer = setTimeout(async () => {
    // If the session changed between scheduling and firing, discard.
    if (pendingPreferenceSync.sessionId !== capturedSessionId) return;

    const payload = { ...pendingPreferenceSync.patch };
    pendingPreferenceSync.patch = {};
    pendingPreferenceSync.timer = null;
    if (Object.keys(payload).length === 0) return;

    // Abort any previous in-flight sync and create a fresh controller.
    if (activeSyncController) activeSyncController.abort();
    activeSyncController = new AbortController();

    try {
      await putUserPreferences(payload, { signal: activeSyncController.signal });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      console.warn('Failed to sync user preferences:', error);
    } finally {
      activeSyncController = null;
    }
  }, debounceMs);
}

export async function getDocumentProgress(
  documentId: string,
  options?: { signal?: AbortSignal },
): Promise<DocumentProgressRecord | null> {
  const res = await fetch(`/api/user/state/progress?documentId=${encodeURIComponent(documentId)}`, {
    signal: options?.signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to load document progress');
  }
  const data = (await res.json()) as ProgressResponse;
  return data.progress ?? null;
}

export async function putDocumentProgress(payload: {
  documentId: string;
  readerType: ReaderType;
  location: string;
  progress?: number | null;
  clientUpdatedAtMs?: number;
  signal?: AbortSignal;
}): Promise<DocumentProgressRecord | null> {
  const res = await fetch('/api/user/state/progress', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId: payload.documentId,
      readerType: payload.readerType,
      location: payload.location,
      progress: payload.progress ?? null,
      clientUpdatedAtMs: payload.clientUpdatedAtMs ?? Date.now(),
    }),
    signal: payload.signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to update document progress');
  }
  const data = (await res.json()) as ProgressResponse;
  return data.progress ?? null;
}

type PendingProgressSync = {
  payload: {
    documentId: string;
    readerType: ReaderType;
    location: string;
    progress: number | null;
  };
  timer: ReturnType<typeof setTimeout> | null;
};

const pendingProgressByDoc = new Map<string, PendingProgressSync>();

export function scheduleDocumentProgressSync(
  payload: {
    documentId: string;
    readerType: ReaderType;
    location: string;
    progress?: number | null;
  },
  debounceMs: number = 1000,
): void {
  const existing = pendingProgressByDoc.get(payload.documentId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  const next: PendingProgressSync = {
    payload: {
      documentId: payload.documentId,
      readerType: payload.readerType,
      location: payload.location,
      progress: payload.progress ?? null,
    },
    timer: null,
  };

  next.timer = setTimeout(async () => {
    pendingProgressByDoc.delete(payload.documentId);
    try {
      await putDocumentProgress({
        documentId: next.payload.documentId,
        readerType: next.payload.readerType,
        location: next.payload.location,
        progress: next.payload.progress,
      });
    } catch (error) {
      console.warn('Failed to sync document progress:', error);
    }
  }, debounceMs);

  pendingProgressByDoc.set(payload.documentId, next);
}
