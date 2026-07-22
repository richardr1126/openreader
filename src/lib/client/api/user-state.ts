import {
  SYNCED_PREFERENCE_KEYS,
  type DocumentProgressPayload,
  type DocumentProgressRecord,
  type SyncedPreferencesPatch,
} from '@/types/user-state';

export type PreferencesResponse = {
  preferences: SyncedPreferencesPatch;
  clientUpdatedAtMs: number;
  hasStoredPreferences?: boolean;
};

type ProgressResponse = {
  progress: DocumentProgressRecord | null;
};

type ChangelogVersionCheckResponse = {
  shouldOpen: boolean;
  currentVersion: string;
  lastSeenVersion: string | null;
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

export async function postChangelogVersionCheck(
  currentVersion: string,
  options?: { signal?: AbortSignal },
): Promise<ChangelogVersionCheckResponse> {
  const res = await fetch('/api/user/state/changelog/version-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentVersion }),
    signal: options?.signal,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to check changelog version');
  }

  return (await res.json()) as ChangelogVersionCheckResponse;
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

export async function putDocumentProgress(
  payload: DocumentProgressPayload & { signal?: AbortSignal },
): Promise<DocumentProgressRecord | null> {
  const res = await fetch('/api/user/state/progress', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId: payload.documentId,
      readerType: payload.readerType,
      ...(payload.readerType === 'epub'
        ? { locator: payload.locator }
        : { location: payload.location }),
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
