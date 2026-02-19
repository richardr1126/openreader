'use client';

import { useAuthRateLimit, formatCharCount } from '@/contexts/AuthRateLimitContext';
import Link from 'next/link';

interface RateLimitBannerProps {
  className?: string;
}

export function RateLimitBanner({ className = '' }: RateLimitBannerProps) {
  const { status, isAtLimit, timeUntilReset, authEnabled } = useAuthRateLimit();

  // Don't show banner if auth is not enabled or if not at limit
  if (!authEnabled || !status?.authEnabled || !isAtLimit) {
    return null;
  }

  const isAnonymous = status.userType === 'anonymous';

  return (
    <div className={`bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="text-xs sm:text-sm">
          <span className="font-medium text-amber-700 dark:text-amber-400">
            Daily TTS limit reached.
          </span>
          <span className="text-amber-600 dark:text-amber-500 ml-1.5">
            {`Used ${formatCharCount(status.currentCount)} / ${formatCharCount(status.limit)} characters.`}
            {' Resets in '}{timeUntilReset}.
          </span>
        </div>

        {isAnonymous && (
          <Link
            href="/signup"
            className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-md
                     bg-accent text-background hover:bg-secondary-accent
                     transform transition-transform duration-200 hover:scale-[1.04]"
          >
            Sign up for a higher limit
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Compact version for inline display
 */
export function RateLimitIndicator({ className = '' }: RateLimitBannerProps) {
  const { status, isAtLimit, authEnabled } = useAuthRateLimit();

  // Don't show if auth is not enabled
  if (!authEnabled || !status?.authEnabled) {
    return null;
  }

  const percentage = status.limit > 0
    ? Math.min(100, (status.currentCount / status.limit) * 100)
    : 0;

  const isWarning = percentage >= 80;

  if (isAtLimit) {
    return (
      <span className={`text-xs font-medium text-amber-600 dark:text-amber-400 ${className}`}>
        Limit reached
      </span>
    );
  }

  if (isWarning) {
    return (
      <span className={`text-xs text-muted ${className}`}>
        {formatCharCount(status.remainingChars)} chars left
      </span>
    );
  }

  return null;
}
