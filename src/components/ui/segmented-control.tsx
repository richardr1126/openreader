'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
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
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusOption((index - 1 + options.length) % options.length);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusOption((index + 1) % options.length);
        break;
      case 'Home':
        event.preventDefault();
        focusOption(0);
        break;
      case 'End':
        event.preventDefault();
        focusOption(options.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn(segmentedGroupClass, className)}>
      {options.map((option, index) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            ref={(el) => { buttonRefs.current[index] = el; }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={segmentedButtonClass(active)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
