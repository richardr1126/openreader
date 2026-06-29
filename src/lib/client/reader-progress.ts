import type { DocumentType } from '@/types/documents';
import type { TTSLocation } from '@/types/tts';

export type ReaderInitialPosition =
  | { readerType: 'pdf'; location: number; segmentOrdinal: number }
  | { readerType: 'html'; location: TTSLocation; segmentOrdinal: number }
  | { readerType: 'epub'; location: string }
  | null;

function parsePositionToken(location: string): { location: number; segmentOrdinal: number } | null {
  const match = /^(\d+):(\d+)$/.exec(location);
  if (!match) return null;
  return {
    location: Math.max(1, Number(match[1])),
    segmentOrdinal: Math.max(0, Number(match[2])),
  };
}

export function parseReaderInitialPosition(
  readerType: DocumentType,
  location: string | null | undefined,
): ReaderInitialPosition {
  if (!location) return null;

  if (readerType === 'epub') {
    return location === 'next' || location === 'prev'
      ? null
      : { readerType, location };
  }

  if (readerType === 'pdf') {
    const parsed = parsePositionToken(location);
    return parsed ? { readerType, ...parsed } : null;
  }

  if (readerType === 'html') {
    const match = /^html:([^:]+):(\d+)$/.exec(location);
    if (match) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(match[1]);
      } catch {
        return null;
      }
      const numeric = Number(decoded);
      const resolvedLocation: TTSLocation = decoded.trim() !== '' && Number.isFinite(numeric)
        ? numeric
        : decoded || 1;
      return {
        readerType,
        location: resolvedLocation,
        segmentOrdinal: Math.max(0, Number(match[2])),
      };
    }

    const legacy = parsePositionToken(location);
    return legacy ? { readerType, ...legacy } : null;
  }

  return null;
}

export function serializeReaderPosition(
  readerType: 'pdf' | 'html',
  location: TTSLocation,
  segmentOrdinal: number,
): string {
  const safeOrdinal = Math.max(0, Math.floor(segmentOrdinal));
  if (readerType === 'html') {
    // Empty strings must default to a valid token too: `html::${idx}` fails to
    // round-trip through parseReaderInitialPosition (its location group requires
    // a non-empty match), so an empty location would silently drop progress.
    const safeLocation = location == null || location === '' ? 1 : location;
    return `html:${encodeURIComponent(String(safeLocation))}:${safeOrdinal}`;
  }
  return `${Math.max(1, Number(location) || 1)}:${safeOrdinal}`;
}
