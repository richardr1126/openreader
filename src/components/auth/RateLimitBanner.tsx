'use client';

import { useAuthRateLimit, formatCharCount } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import Link from 'next/link';

interface RateLimitBannerProps {
  className?: string;
}

export function RateLimitBanner({ className = '' }: RateLimitBannerProps) {
  const { status, isAtLimit, timeUntilReset } = useAuthRateLimit();
  const canSignUp = useRuntimeConfig().signupPolicy !== 'closed';

  if (!status || !isAtLimit) {
    return null;
  }

  const isAnonymous = status.userType === 'anonymous';

  return (
    <div className={`bg-accent-wash border border-accent-line rounded-lg px-3 py-2 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="text-xs sm:text-sm">
          <span className="font-medium text-accent ">
            Daily TTS limit reached.
          </span>
          <span className="text-accent  ml-1.5">
            {`Used ${formatCharCount(status.currentCount)} / ${formatCharCount(status.limit ?? 0)} characters.`}
            {' Cached audio remains available; new generation resumes in '}{timeUntilReset}.
          </span>
        </div>

        {isAnonymous && canSignUp && (
          <Link
            href="/signup"
            className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-md
                     bg-accent text-background hover:bg-secondary-accent
                     transform transition-transform duration-base"
          >
            Sign up for a higher limit
          </Link>
        )}
      </div>
    </div>
  );
}
