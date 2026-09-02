'use client';

import { Button } from './button';
import { cn } from './cn';
import { LoadingSpinner } from '@/components/Spinner';
import { ApiError } from '@/lib/client/api/http';

/**
 * Reusable loading / error / empty / refresh UI for the data-storage refactor's
 * standard query contract. Domain views compose these so every screen renders
 * pending, failed, empty, and background-refresh states the same way.
 */

export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/** Hard error: query failed with no usable data. Offers a retry action. */
export function QueryError({
  error,
  onRetry,
  retrying = false,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-12 text-center', className)} role="alert">
      <p className="text-sm text-danger">{errorMessage(error)}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Non-blocking refresh indicator: usable data is shown while a refetch runs, or
 * a background refresh failed (`warn`). Returns null when idle.
 */
export function RefreshIndicator({
  refreshing,
  warn = false,
  className,
}: {
  refreshing: boolean;
  warn?: boolean;
  className?: string;
}) {
  if (!refreshing && !warn) return null;
  return (
    <div className={cn('flex items-center gap-2 text-xs', warn ? 'text-danger' : 'text-soft', className)} aria-live="polite">
      {refreshing ? <LoadingSpinner className="w-3 h-3 text-accent" /> : null}
      <span>{warn ? 'Couldn’t refresh — showing saved data.' : 'Refreshing…'}</span>
    </div>
  );
}
