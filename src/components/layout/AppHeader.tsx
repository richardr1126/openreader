import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export function AppHeader({
  left,
  title,
  right,
  className,
}: {
  left?: ReactNode;
  title?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('sticky top-0 z-40 w-full border-b border-line-soft bg-surface', className)} data-app-header>
      <div className="px-2 sm:px-3 py-1 flex items-center justify-between gap-2 min-h-10">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {left}
          {typeof title === 'string' ? (
            <h1 className="text-xs md:text-sm font-semibold truncate text-foreground tracking-tight">{title}</h1>
          ) : (
            title
          )}
        </div>
        <div className="flex items-center gap-2 min-w-0 justify-end">{right}</div>
      </div>
    </div>
  );
}
