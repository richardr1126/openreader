import type { DocumentType } from '@/types/documents';
import type { TTSLocation } from '@/types/tts';

export type ReaderInitialPosition =
  | { readerType: 'pdf'; location: number; sentenceIndex: number }
  | { readerType: 'html'; location: TTSLocation; sentenceIndex: number }
  | { readerType: 'epub'; location: string }
  | null;

function parseLegacyPosition(location: string): { location: number; sentenceIndex: number } | null {
  const match = /^(\d+):(\d+)$/.exec(location);
  if (!match) return null;
  return {
    location: Math.max(1, Number(match[1])),
    sentenceIndex: Math.max(0, Number(match[2])),
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
    const parsed = parseLegacyPosition(location);
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
        sentenceIndex: Math.max(0, Number(match[2])),
      };
    }

    const legacy = parseLegacyPosition(location);
    return legacy ? { readerType, ...legacy } : null;
  }

  return null;
}

export function serializeReaderPosition(
  readerType: 'pdf' | 'html',
  location: TTSLocation,
  sentenceIndex: number,
): string {
  const safeIndex = Math.max(0, Math.floor(sentenceIndex));
  if (readerType === 'html') {
    return `html:${encodeURIComponent(String(location ?? 1))}:${safeIndex}`;
  }
  return `${Math.max(1, Number(location) || 1)}:${safeIndex}`;
}
