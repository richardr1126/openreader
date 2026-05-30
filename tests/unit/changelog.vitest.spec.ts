import { describe, expect, test } from 'vitest';

import {
  findCurrentVersionIndex,
  isMutableIndex,
  normalizeVersion,
  sortManifestEntries,
  tagsMatchVersion,
  toSafeTagSlug,
  type ChangelogManifestEntry,
} from '../../src/lib/shared/changelog';

describe('changelog utilities', () => {
  test('normalizes version strings with and without v prefix', () => {
    expect(normalizeVersion('v2.2.0')).toBe('2.2.0');
    expect(normalizeVersion('2.2.0')).toBe('2.2.0');
    expect(normalizeVersion(' V2.2.0 ')).toBe('2.2.0');
  });

  test('matches tag and version reliably', () => {
    expect(tagsMatchVersion('v2.2.0', '2.2.0')).toBe(true);
    expect(tagsMatchVersion('2.2.0', 'v2.2.0')).toBe(true);
    expect(tagsMatchVersion('v2.2.1', '2.2.0')).toBe(false);
  });

  test('finds the running version index in manifest entries', () => {
    const entries: ChangelogManifestEntry[] = [
      {
        tag_name: 'v2.3.0',
        name: 'v2.3.0',
        published_at: '2026-05-01T00:00:00.000Z',
        html_url: 'https://example.com/1',
        prerelease: false,
        body_path: 'changelog/releases/v2-3-0.json',
      },
      {
        tag_name: 'v2.2.0',
        name: 'v2.2.0',
        published_at: '2026-04-01T00:00:00.000Z',
        html_url: 'https://example.com/2',
        prerelease: false,
        body_path: 'changelog/releases/v2-2-0.json',
      },
    ];

    expect(findCurrentVersionIndex(entries, '2.2.0')).toBe(1);
    expect(findCurrentVersionIndex(entries, 'v2.3.0')).toBe(0);
    expect(findCurrentVersionIndex(entries, '1.0.0')).toBe(-1);
  });

  test('sorts manifest newest first by published_at', () => {
    const entries: ChangelogManifestEntry[] = [
      {
        tag_name: 'v2.1.0',
        name: 'v2.1.0',
        published_at: '2026-03-01T00:00:00.000Z',
        html_url: 'https://example.com/1',
        prerelease: false,
        body_path: 'changelog/releases/v2-1-0.json',
      },
      {
        tag_name: 'v2.3.0',
        name: 'v2.3.0',
        published_at: '2026-05-01T00:00:00.000Z',
        html_url: 'https://example.com/3',
        prerelease: false,
        body_path: 'changelog/releases/v2-3-0.json',
      },
      {
        tag_name: 'v2.2.0',
        name: 'v2.2.0',
        published_at: '2026-04-01T00:00:00.000Z',
        html_url: 'https://example.com/2',
        prerelease: false,
        body_path: 'changelog/releases/v2-2-0.json',
      },
    ];

    expect(sortManifestEntries(entries).map((entry) => entry.tag_name)).toEqual(['v2.3.0', 'v2.2.0', 'v2.1.0']);
  });

  test('treats only newest three entries as mutable by default', () => {
    expect(isMutableIndex(0)).toBe(true);
    expect(isMutableIndex(1)).toBe(true);
    expect(isMutableIndex(2)).toBe(true);
    expect(isMutableIndex(3)).toBe(false);
  });

  test('builds filesystem-safe slugs for release tags', () => {
    expect(toSafeTagSlug('v2.2.0')).toBe('v2.2.0');
    expect(toSafeTagSlug('v2.2.0+build/meta')).toBe('v2.2.0-build-meta');
  });
});
