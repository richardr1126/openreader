'use client';

import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/client/query-keys';
import { fetchChangelogManifest, fetchChangelogReleaseBody } from '@/lib/client/changelog';
import type { ChangelogManifestEntry, ChangelogReleaseBody } from '@/lib/shared/changelog';

const MANIFEST_STALE_TIME = 5 * 60 * 1000;

export function useChangelogManifest(manifestUrl: string) {
  return useQuery({
    queryKey: queryKeys.changelogManifest(manifestUrl),
    queryFn: ({ signal }) => fetchChangelogManifest(manifestUrl, signal),
    enabled: Boolean(manifestUrl),
    staleTime: MANIFEST_STALE_TIME,
  });
}

/**
 * Lazily fetches release bodies for the currently-expanded entries and returns
 * them keyed by tag name (matching the shape the panel renders against).
 * Bodies are immutable once published, so each is cached indefinitely and
 * survives the changelog panel being closed and reopened.
 */
export function useChangelogReleaseBodies(
  manifestUrl: string,
  entries: ChangelogManifestEntry[],
  expanded: Record<string, boolean>,
): Record<string, ChangelogReleaseBody> {
  const expandedEntries = useMemo(
    () => entries.filter((entry) => expanded[entry.tag_name]),
    [entries, expanded],
  );

  const results = useQueries({
    queries: expandedEntries.map((entry) => ({
      queryKey: queryKeys.changelogReleaseBody(manifestUrl, entry.body_path),
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        fetchChangelogReleaseBody(manifestUrl, entry.body_path, signal),
      enabled: Boolean(manifestUrl),
      staleTime: Infinity,
    })),
  });

  return useMemo(() => {
    const map: Record<string, ChangelogReleaseBody> = {};
    expandedEntries.forEach((entry, index) => {
      const data = results[index]?.data;
      if (data) map[entry.tag_name] = data;
    });
    return map;
  }, [expandedEntries, results]);
}
