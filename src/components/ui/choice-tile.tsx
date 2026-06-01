import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { focusRing, motionColors } from './tokens';

export function ChoiceTile({
  selected = false,
  children,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left',
        'transition duration-base ease-standard',
        focusRing,
        motionColors,
        selected ? 'border-accent-line' : 'border-line hover:border-accent-line',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
