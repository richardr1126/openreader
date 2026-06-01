import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { motionColors } from './tokens';

export function SearchField({
  icon,
  className,
  inputClassName,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  icon?: ReactNode;
  inputClassName?: string;
}) {
  return (
    <label
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2 py-1',
        'focus-within:border-accent-line focus-within:ring-1 focus-within:ring-accent-line hover:border-accent-line',
        motionColors,
        className,
      )}
    >
      {icon ? <span className="shrink-0 text-soft">{icon}</span> : null}
      <input
        type="search"
        className={cn('min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-soft', inputClassName)}
        {...props}
      />
    </label>
  );
}
