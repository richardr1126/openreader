import { compareSegmentLocators, locatorGroupKey, locatorIdentityKey } from '@openreader/tts/locator';
import type {
  TTSSegmentLocator,
  TTSSegmentVariant,
} from '@/types/client';

export { locatorGroupKey, locatorIdentityKey };

export const DEFAULT_PAGE_SIZE = 150;
export const MIN_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 500;

export type TTSSegmentManifestCursor = {
  locatorReaderRank: number;
  locatorSpineIndex: number;
  locatorCharOffset: number;
  locatorSpineHref: string;
  locatorPage: number;
  locatorLocation: string;
  segmentIndex: number;
  locatorIdentityKey: string;
  segmentEntryId: string;
};

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

export function decodeManifestCursor(cursor: string | null): TTSSegmentManifestCursor | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded) return null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    const next: TTSSegmentManifestCursor = {
      locatorReaderRank: Number(rec.locatorReaderRank),
      locatorSpineIndex: Number(rec.locatorSpineIndex),
      locatorCharOffset: Number(rec.locatorCharOffset),
      locatorSpineHref: typeof rec.locatorSpineHref === 'string' ? rec.locatorSpineHref : '',
      locatorPage: Number(rec.locatorPage),
      locatorLocation: typeof rec.locatorLocation === 'string' ? rec.locatorLocation : '',
      segmentIndex: Number(rec.segmentIndex),
      locatorIdentityKey: typeof rec.locatorIdentityKey === 'string' ? rec.locatorIdentityKey : '',
      segmentEntryId: typeof rec.segmentEntryId === 'string' ? rec.segmentEntryId : '',
    };
    if (!Number.isFinite(next.locatorReaderRank)) return null;
    if (!Number.isFinite(next.locatorSpineIndex)) return null;
    if (!Number.isFinite(next.locatorCharOffset)) return null;
    if (!Number.isFinite(next.locatorPage)) return null;
    if (!Number.isFinite(next.segmentIndex)) return null;
    if (!next.locatorIdentityKey) return null;
    if (!next.segmentEntryId) return null;
    const normalizedInput = cursor.replace(/=+$/, '');
    if (encodeManifestCursor(next) !== normalizedInput) {
      return null;
    }
    return next;
  } catch {
    return null;
  }
}

export function encodeManifestCursor(value: TTSSegmentManifestCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function parseManifestPageSize(value: string | null): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, parsed));
}
