'use client';

import { cn } from './cn';
import { focusRing, motionColors } from './tokens';

export type SwitchSize = 'sm' | 'md';

const SWITCH_SIZE: Record<SwitchSize, { track: string; thumb: string; on: string; off: string }> = {
  sm: {
    track: 'h-4 w-7',
    thumb: 'h-3 w-3',
    on: 'translate-x-3',
    off: 'translate-x-0.5',
  },
  md: {
    track: 'h-5 w-9',
    thumb: 'h-4 w-4',
    on: 'translate-x-4',
    off: 'translate-x-0.5',
  },
};

export function Switch({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: SwitchSize;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  className?: string;
}) {
  const s = SWITCH_SIZE[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-line disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-line-strong',
        s.track,
        focusRing,
        motionColors,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-block rounded-full bg-surface shadow-elev-1 ring-0 transition-transform duration-fast ease-standard',
          checked ? s.on : s.off,
          s.thumb,
        )}
      />
    </button>
  );
}
