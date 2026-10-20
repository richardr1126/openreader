import type { ChangelogManifestEntry, DesktopInstaller } from '@/lib/shared/changelog';
import { sortManifestEntries } from '@/lib/shared/changelog';
import { LINKS } from './links';

/**
 * The public pages read the official docs changelog feed
 * (scripts/build-changelog-feed.mjs), never the GitHub API: CI makes the only
 * GitHub calls, and every instance reads one static, cached file. It is the
 * project's feed regardless of the instance's own changelog setting, because the
 * desktop builds are the project's. Any failure renders without it.
 */
const REVALIDATE_SECONDS = 3600;
const TIMEOUT_MS = 5000;

export interface DesktopRelease {
  version: string;
  publishedAt: string;
  notesUrl: string;
  installers: DesktopInstaller[];
}

export interface ReleaseFeed {
  stars: number | null;
  /** Releases that carry desktop installers, newest first. */
  desktopReleases: DesktopRelease[];
}

interface FeedDocument {
  repo?: { stars?: unknown };
  releases?: ChangelogManifestEntry[];
}

export async function getReleaseFeed(): Promise<ReleaseFeed> {
  let doc: FeedDocument | null = null;
  try {
    const response = await fetch(LINKS.releaseFeed, {
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) doc = (await response.json()) as FeedDocument;
  } catch {
    doc = null;
  }

  const stars = doc?.repo?.stars;
  const releases = Array.isArray(doc?.releases) ? sortManifestEntries(doc.releases) : [];
  return {
    stars: typeof stars === 'number' && Number.isFinite(stars) ? stars : null,
    desktopReleases: releases
      .filter((r) => !r.prerelease && Array.isArray(r.desktop_installers) && r.desktop_installers.length > 0)
      .map((r) => ({
        version: r.tag_name.replace(/^v/, ''),
        publishedAt: r.published_at,
        notesUrl: r.html_url,
        installers: r.desktop_installers ?? [],
      })),
  };
}
