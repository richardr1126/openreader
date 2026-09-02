import { normalizeLocator } from '@openreader/tts/locator';

import type { EpubProgressLocator } from '@/types/user-state';

const EPUB_PROGRESS_PREFIX = 'epub:v1:';

export function normalizeEpubProgressLocator(value: unknown): EpubProgressLocator | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  const normalized = normalizeLocator({
    readerType: 'epub',
    spineHref: typeof record.spineHref === 'string' ? record.spineHref : undefined,
    spineIndex: typeof record.spineIndex === 'number' ? record.spineIndex : undefined,
    charOffset: typeof record.charOffset === 'number' ? record.charOffset : undefined,
  });
  if (
    normalized?.readerType !== 'epub'
    || typeof normalized.spineHref !== 'string'
    || typeof normalized.spineIndex !== 'number'
    || typeof normalized.charOffset !== 'number'
  ) return null;
  return {
    schemaVersion: 1,
    spineHref: normalized.spineHref,
    spineIndex: normalized.spineIndex,
    charOffset: normalized.charOffset,
  };
}

export function serializeEpubProgressLocator(locator: EpubProgressLocator): string {
  const normalized = normalizeEpubProgressLocator(locator);
  if (!normalized) throw new Error('Invalid EPUB progress locator');
  return `${EPUB_PROGRESS_PREFIX}${encodeURIComponent(JSON.stringify(normalized))}`;
}

export function parseEpubProgressLocator(value: string | null | undefined): EpubProgressLocator | null {
  if (!value?.startsWith(EPUB_PROGRESS_PREFIX)) return null;
  try {
    return normalizeEpubProgressLocator(JSON.parse(decodeURIComponent(value.slice(EPUB_PROGRESS_PREFIX.length))));
  } catch {
    return null;
  }
}
