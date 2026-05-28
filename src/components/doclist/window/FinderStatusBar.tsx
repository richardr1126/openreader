'use client';

interface FinderStatusBarProps {
  itemCount: number;
  selectedCount: number;
  totalSize: number;
  summary?: string;
}

function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(2)} MB`;
}

export function FinderStatusBar({
  itemCount,
  selectedCount,
  totalSize,
  summary,
}: FinderStatusBarProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="h-6 px-3 flex items-center justify-between gap-3 text-[11px] text-muted bg-base border-t border-offbase select-none"
    >
      <span className="truncate">{summary}</span>
      <span className="shrink-0">
        {selectedCount > 0
          ? `${selectedCount} of ${itemCount} selected`
          : `${itemCount} item${itemCount === 1 ? '' : 's'}`}
        <span className="mx-1.5 text-muted">•</span>
        {formatSize(totalSize)}
      </span>
    </div>
  );
}
