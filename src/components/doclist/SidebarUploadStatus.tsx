import { Button } from '@/components/ui';
import { formatDocumentSize } from '@/components/doclist/formatSize';
import type { DocumentUploadSummary } from '@/lib/client/uploads/state';

export function SidebarUploadStatus({
  summary,
  onCancel,
  onRetry,
  onDismiss,
}: {
  summary: DocumentUploadSummary;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const title = summary.isActive
    ? 'Uploading'
    : summary.hasFailures
      ? 'Upload failed'
      : 'Upload complete';
  const count = `${summary.completedFiles}/${summary.totalFiles}`;
  const showBytes = summary.isActive && summary.totalBytes > 0;

  return (
    <div
      className="rounded-md border border-line bg-surface-sunken px-2 py-2"
      role={summary.hasFailures && !summary.isActive ? 'alert' : undefined}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 text-[11px] leading-tight">
        <div className="min-w-0 flex items-center gap-1.5">
          <span className="font-medium text-foreground">{title}</span>
          <span className="shrink-0 tabular-nums text-soft">{count}</span>
        </div>
        <span className="shrink-0 tabular-nums text-soft">{summary.progress}%</span>
      </div>

      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-line"
        aria-label={`Upload progress ${summary.progress}%`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-200 ease-standard ${
            summary.hasFailures && !summary.isActive ? 'bg-danger' : 'bg-accent'
          }`}
          style={{ width: `${summary.progress}%` }}
        />
      </div>

      <p className="mt-1.5 truncate text-[10px] text-soft" title={summary.currentFileName ?? undefined}>
        {summary.currentFileName ?? summary.detail}
      </p>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-soft">
        <span className="truncate">{summary.detail}</span>
        {showBytes && (
          <span className="shrink-0 tabular-nums">
            {formatDocumentSize(summary.transferredBytes)} / {formatDocumentSize(summary.totalBytes)}
          </span>
        )}
      </div>

      {summary.error && !summary.isActive && (
        <p className="mt-1.5 line-clamp-2 text-[10px] leading-snug text-danger">
          {summary.error}
        </p>
      )}

      <div className="mt-1.5 flex justify-end gap-1">
        {summary.isActive ? (
          <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
        ) : summary.hasFailures ? (
          <>
            <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button>
            <Button size="xs" variant="outline" onClick={onRetry}>Retry</Button>
          </>
        ) : (
          <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button>
        )}
      </div>
    </div>
  );
}
