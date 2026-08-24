'use client';

import { Button } from '@/components/ui';
import type { ReaderBootstrapProgress } from '@/types/reader-bootstrap';
import styles from './ReaderLoader.module.css';

export function ReaderLoader({ progress }: { progress?: ReaderBootstrapProgress }) {
  const totalPages = progress?.totalPages ?? 0;
  const pagesParsed = Math.min(totalPages, Math.max(0, progress?.pagesParsed ?? 0));
  const percent = totalPages > 0 ? Math.round((pagesParsed / totalPages) * 100) : null;
  const modelTotalBytes = Math.max(0, progress?.totalBytes ?? 0);
  const modelDownloadedBytes = Math.min(modelTotalBytes, Math.max(0, progress?.downloadedBytes ?? 0));
  const modelPercent = modelTotalBytes > 0 ? Math.round((modelDownloadedBytes / modelTotalBytes) * 100) : null;
  const displayedPercent = progress?.phase === 'downloading-model' ? modelPercent : percent;
  const title = progress?.phase === 'downloading-model'
    ? 'Downloading document model'
    : progress?.phase === 'merging'
    ? 'Finishing document structure'
    : progress
      ? 'Understanding document structure'
      : 'Opening document';
  const detail = progress?.phase === 'downloading-model'
    ? 'This one-time download prepares PDF reading order on this device'
    : progress
    ? 'Finding the reading order across each page'
    : 'Preparing your reader and saved position';

  return (
    <div className={styles.root} data-testid="reader-loader">
      <div className={styles.ambient} aria-hidden />
      <div className={styles.content} role="status" aria-live="polite">
        <div className={styles.mark} data-parsing={progress ? 'true' : 'false'} aria-hidden>
          <div className={styles.sheet}>
            <span className={styles.fold} />
            <span className={styles.lineOne} />
            <span className={styles.lineTwo} />
            <span className={styles.lineThree} />
            <span className={styles.blockOne} />
            <span className={styles.blockTwo} />
            <span className={styles.cursor} />
            <span className={styles.scan} />
          </div>
        </div>

        <div className={styles.copy}>
          <p className={styles.eyebrow}>{progress ? 'PDF preparation' : 'Reader preparation'}</p>
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>

        <div
          className={styles.progress}
          role="progressbar"
          aria-label={progress ? 'PDF structure progress' : title}
          aria-valuemin={progress && displayedPercent !== null ? 0 : undefined}
          aria-valuemax={progress && displayedPercent !== null ? 100 : undefined}
          aria-valuenow={progress ? displayedPercent ?? undefined : undefined}
        >
          {progress ? (
            <div className={styles.progressLabels}>
              <span>{progress.phase === 'downloading-model'
                ? 'Downloading model'
                : totalPages > 0 ? `Page ${pagesParsed} of ${totalPages}` : 'Preparing the first page'}</span>
              <span>{progress.phase === 'merging'
                ? 'Finishing structure'
                : (displayedPercent === null ? 'Starting' : `${displayedPercent}%`)}</span>
            </div>
          ) : null}
          <div className={styles.track} data-indeterminate={progress && displayedPercent !== null ? 'false' : 'true'}>
            <span style={progress && displayedPercent !== null ? { width: `${displayedPercent}%` } : undefined} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReaderError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry?: () => void;
}) {
  return (
    <div className={styles.root}>
      <div className={styles.ambient} aria-hidden />
      <div className={styles.content} role="alert">
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Preparation paused</p>
          <h2>This document is not ready yet</h2>
          <p>{error.message}</p>
        </div>
        {onRetry ? (
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
