'use client';

import { useState } from 'react';
import { EyeIcon } from '@/components/icons/Icons';
import { IconButton } from '@/components/ui';

/**
 * Hidden until asked for. The blur covers a mask rather than the address, so a
 * screenshot or screen share of the page cannot be unblurred back into it.
 */
export function PrivateEmail({ email }: { email: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      {revealed
        ? <span className="min-w-0 break-all font-mono text-foreground">{email}</span>
        : <span aria-hidden="true" className="min-w-0 select-none break-all font-mono text-foreground blur-[3px]">{email.replace(/[^@.]/g, 'x')}</span>}
      <IconButton
        size="xs"
        aria-label="Show email"
        aria-pressed={revealed}
        onClick={() => setRevealed(!revealed)}
        className={`shrink-0 ${revealed ? 'text-accent' : 'text-soft'}`}
      >
        <EyeIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </IconButton>
    </span>
  );
}
