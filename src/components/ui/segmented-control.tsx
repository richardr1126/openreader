import type { ReactNode } from 'react';
import { cn } from './cn';
import { focusRing, motionColors } from './tokens';

export const segmentedGroupClass = 'grid gap-1 rounded-full border border-line bg-surface-sunken p-1';

export const segmentedButtonClass = (active: boolean) =>
  cn(
    'rounded-full px-2.5 py-1.5 text-xs font-medium',
    focusRing,
    motionColors,
    active ? 'bg-accent text-background' : 'text-soft hover:bg-accent-wash hover:text-foreground',
  );

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn(segmentedGroupClass, className)}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={segmentedButtonClass(active)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
