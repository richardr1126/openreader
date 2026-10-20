export interface DesktopInstaller {
  name: string;
  url: string;
  /** Bytes. */
  size: number;
  platform: 'mac' | 'windows' | 'linux';
  arch: 'arm64' | 'x64';
  format: string;
}

export interface ChangelogManifestEntry {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  body_path: string;
  /** Written by scripts/build-changelog-feed.mjs; absent from older feeds. */
  desktop_installers?: DesktopInstaller[];
}

export interface ChangelogReleaseBody extends ChangelogManifestEntry {
  body: string;
}

export function normalizeVersion(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

export function tagsMatchVersion(tag: string, version: string): boolean {
  const left = normalizeVersion(tag);
  const right = normalizeVersion(version);
  return !!left && !!right && left === right;
}

export function sortManifestEntries(entries: ChangelogManifestEntry[]): ChangelogManifestEntry[] {
  return [...entries].sort((a, b) => {
    const aMs = Date.parse(a.published_at);
    const bMs = Date.parse(b.published_at);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
      return bMs - aMs;
    }
    return b.tag_name.localeCompare(a.tag_name);
  });
}

export function findCurrentVersionIndex(entries: ChangelogManifestEntry[], appVersion: string): number {
  return entries.findIndex((entry) => tagsMatchVersion(entry.tag_name, appVersion));
}

export function shouldOpenChangelogForVersionChange(
  lastSeenVersion: string | null | undefined,
  currentVersion: string | null | undefined,
): boolean {
  const normalizedCurrent = normalizeVersion(currentVersion ?? '');
  if (!normalizedCurrent) return false;
  const normalizedLastSeen = normalizeVersion(lastSeenVersion ?? '');
  return normalizedLastSeen !== normalizedCurrent;
}

export function toSafeTagSlug(tagName: string): string {
  const normalized = tagName.trim().toLowerCase();
  const collapsed = normalized
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return collapsed || 'release';
}

export function isMutableIndex(index: number, mutableCount = 3): boolean {
  return index >= 0 && index < mutableCount;
}
