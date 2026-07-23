'use client';

import { Button } from '@/components/ui';
import type { ReaderBootstrapProgress } from '@/types/reader-bootstrap';
import styles from './ReaderLoader.module.css';

export function ReaderLoader({ progress }: { progress?: ReaderBootstrapProgress }) {
  const totalPages = progress?.totalPages ?? 0;
  const pagesParsed = Math.min(totalPages, Math.max(0, progress?.pagesParsed ?? 0));
  const percent = totalPages > 0 ? Math.round((pagesParsed / totalPages) * 100) : null;
  const title = progress?.phase === 'merging'
    ? 'Finishing document structure'
    : progress
      ? 'Understanding document structure'
      : 'Opening document';
  const detail = progress
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
          aria-valuemin={progress && percent !== null ? 0 : undefined}
          aria-valuemax={progress && percent !== null ? 100 : undefined}
          aria-valuenow={progress ? percent ?? undefined : undefined}
        >
          {progress ? (
            <div className={styles.progressLabels}>
              <span>{totalPages > 0 ? `Page ${pagesParsed} of ${totalPages}` : 'Preparing the first page'}</span>
              <span>{progress.phase === 'merging' ? 'Finishing structure' : (percent === null ? 'Starting' : `${percent}%`)}</span>
            </div>
          ) : null}
          <div className={styles.track} data-indeterminate={progress && percent !== null ? 'false' : 'true'}>
            <span style={progress && percent !== null ? { width: `${percent}%` } : undefined} />
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
