'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TtsProviderId } from '@/lib/shared/tts-provider-catalog';

export interface SharedProviderEntry {
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  defaultModel: string | null;
  defaultInstructions: string | null;
}

interface State {
  data: SharedProviderEntry[];
  loaded: boolean;
}

const EMPTY: State = { data: [], loaded: false };

/**
 * Fetches the list of admin-configured shared TTS providers visible to the
 * current user. Cached in module-scope state to avoid refetching on every
 * mount. The list rarely changes during a session; admin edits land on the
 * next page load via `__OPENREADER_RUNTIME_CONFIG__`-style behavior.
 */
let cached: State = EMPTY;
let inflight: Promise<SharedProviderEntry[]> | null = null;
const listeners = new Set<(s: State) => void>();

function setCached(next: State) {
  cached = next;
  for (const fn of listeners) fn(next);
}

async function fetchOnce(): Promise<SharedProviderEntry[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/tts/shared-providers', { credentials: 'same-origin' });
      if (!res.ok) return [];
      const data = (await res.json()) as { providers?: SharedProviderEntry[] };
      return data.providers ?? [];
    } catch {
      return [];
    } finally {
      inflight = null;
    }
  })();
  const result = await inflight;
  setCached({ data: result, loaded: true });
  return result;
}

export function useSharedProviders(): {
  providers: SharedProviderEntry[];
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<State>(cached);

  useEffect(() => {
    listeners.add(setState);
    if (!cached.loaded) {
      void fetchOnce();
    }
    return () => {
      listeners.delete(setState);
    };
  }, []);

  const refresh = useCallback(async () => {
    setCached({ ...cached, loaded: false });
    await fetchOnce();
  }, []);

  return { providers: state.data, isLoading: !state.loaded, refresh };
}

export function getCachedSharedProviders(): SharedProviderEntry[] {
  return cached.data;
}
