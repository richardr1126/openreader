'use client';

import { Button } from '@/components/ui';
import type { ReaderLoadPhase } from '@/lib/client/reader-load';
import type { PdfParseProgress } from '@/types/parsed-pdf';
import styles from './ReaderPhaseLoader.module.css';

const PHASE_COPY: Record<Exclude<ReaderLoadPhase, 'ready'>, { title: string; detail: string }> = {
  'opening-document': {
    title: 'Opening document',
    detail: 'Gathering your reader settings and document source',
  },
  'understanding-structure': {
    title: 'Understanding structure',
    detail: 'Finding the reading order across each page',
  },
  'preparing-reading-plan': {
    title: 'Preparing reading plan',
    detail: 'Getting the authoritative text and navigation map ready',
  },
  'setting-your-place': {
    title: 'Setting your place',
    detail: 'Rendering the document at your saved position',
  },
};

export function ReaderPhaseLoader({
  phase,
  error,
  parseProgress,
  onRetry,
}: {
  phase: Exclude<ReaderLoadPhase, 'ready'>;
  error?: Error | null;
  parseProgress?: PdfParseProgress | null;
  onRetry?: () => void;
}) {
  const copy = PHASE_COPY[phase];
  const totalPages = parseProgress?.totalPages ?? 0;
  const pagesParsed = Math.min(totalPages, Math.max(0, parseProgress?.pagesParsed ?? 0));
  const percent = totalPages > 0 ? Math.round((pagesParsed / totalPages) * 100) : null;
  const hasParseProgress = phase === 'understanding-structure' && Boolean(parseProgress);
  const phaseName = phase.replaceAll('-', ' ');

  return (
    <div className={styles.root} data-testid="reader-phase-loader" data-phase={phase}>
      <div className={styles.ambient} aria-hidden />
      <div className={styles.content} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}>
        <div className={styles.mark} data-phase={phase} data-failed={error ? 'true' : 'false'} aria-hidden>
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
          <p className={styles.eyebrow}>{error ? 'Preparation paused' : phaseName}</p>
          <h2>{error ? 'This document is not ready yet' : copy.title}</h2>
          <p>{error?.message || copy.detail}</p>
        </div>

        {!error ? (
          <div
            className={styles.progress}
            role="progressbar"
            aria-label={hasParseProgress ? 'PDF structure progress' : copy.title}
            aria-valuemin={hasParseProgress && percent !== null ? 0 : undefined}
            aria-valuemax={hasParseProgress && percent !== null ? 100 : undefined}
            aria-valuenow={hasParseProgress ? percent ?? undefined : undefined}
          >
            {hasParseProgress ? (
              <div className={styles.progressLabels}>
                <span>{totalPages > 0 ? `Page ${pagesParsed} of ${totalPages}` : 'Preparing the first page'}</span>
                <span>{parseProgress?.phase === 'merge' ? 'Finishing structure' : (percent === null ? 'Starting' : `${percent}%`)}</span>
              </div>
            ) : null}
            <div className={styles.track} data-indeterminate={hasParseProgress && percent !== null ? 'false' : 'true'}>
              <span style={hasParseProgress && percent !== null ? { width: `${percent}%` } : undefined} />
            </div>
          </div>
        ) : null}

        {error && onRetry ? (
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
