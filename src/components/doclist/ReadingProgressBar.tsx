import type { DocumentListDocument } from '@/types/documents';

/** Whole-percent reading progress, or null when unread or not computable. */
export function readingPercent(doc: Pick<DocumentListDocument, 'readingProgress'>): number | null {
  const fraction = doc.readingProgress?.fraction;
  if (fraction == null || !Number.isFinite(fraction)) return null;
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

/** A hairline under a document preview showing how far the user has read. */
export function ReadingProgressBar({ doc }: { doc: DocumentListDocument }) {
  const percent = readingPercent(doc);
  if (percent === null || percent === 0) return null;
  return (
    <div
      role="progressbar"
      aria-label={`Read ${percent}% of ${doc.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-[2px] w-full bg-line-soft"
    >
      <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  );
}
