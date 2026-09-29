'use client';

import { cn } from '@/components/ui';
import { CheckMarkIcon } from './window/finderIcons';

/**
 * Round selection toggle for a document tile/row/thumb. Hidden until hover or
 * focus on pointer devices, always visible on touch (where hover doesn't exist)
 * and whenever a selection is active.
 */
export function SelectCheck({
  checked,
  selectionActive,
  label,
  onToggle,
  className,
}: {
  checked: boolean;
  selectionActive: boolean;
  label: string;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition duration-fast ease-standard',
        'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        checked
          ? 'border-accent bg-accent text-background opacity-100'
          : 'border-line bg-surface-solid text-transparent hover:border-accent-line hover:text-accent',
        !checked && !selectionActive && 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
        className,
      )}
    >
      <CheckMarkIcon className="h-3 w-3" />
    </button>
  );
}
