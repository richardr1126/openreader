import { compareSegmentLocators, locatorGroupKey } from '@/lib/shared/tts-locator';
import type {
  TTSSegmentLocator,
  TTSSegmentVariant,
} from '@/types/client';

export { locatorGroupKey };

export const DEFAULT_PAGE_SIZE = 150;
export const MIN_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 500;

function statusRank(status: TTSSegmentVariant['status']): number {
  if (status === 'completed') return 3;
  if (status === 'pending') return 2;
  return 1;
}

export function dedupeManifestVariants(variants: Array<{ dedupeKey: string; variant: TTSSegmentVariant }>): TTSSegmentVariant[] {
  const byKey = new Map<string, TTSSegmentVariant>();
  for (const { dedupeKey, variant } of variants) {
    const existing = byKey.get(dedupeKey);
    if (!existing) {
      byKey.set(dedupeKey, variant);
      continue;
    }
    const existingRank = statusRank(existing.status);
    const nextRank = statusRank(variant.status);
    const existingUpdatedAt = existing.updatedAt ?? 0;
    const nextUpdatedAt = variant.updatedAt ?? 0;
    if (nextRank > existingRank || (nextRank === existingRank && nextUpdatedAt >= existingUpdatedAt)) {
      byKey.set(dedupeKey, variant);
    }
  }
  return Array.from(byKey.values());
}

export function compareManifestSegments(
  a: { locator: TTSSegmentLocator | null; segmentIndex: number; groupKey: string },
  b: { locator: TTSSegmentLocator | null; segmentIndex: number; groupKey: string },
): number {
  const byLocator = compareSegmentLocators(a.locator, b.locator);
  if (byLocator !== 0) return byLocator;
  if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
  return a.groupKey.localeCompare(b.groupKey);
}

export function decodeManifestCursor(cursor: string | null): string | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded) return null;
    // Reject malformed input that Node's base64url decoder may parse into gibberish.
    const normalizedInput = cursor.replace(/=+$/, '');
    if (encodeManifestCursor(decoded) !== normalizedInput) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function encodeManifestCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function parseManifestPageSize(value: string | null): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, parsed));
}
