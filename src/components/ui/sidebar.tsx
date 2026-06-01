import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export function Sidebar({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <aside
      className={cn('rounded-lg border border-line bg-surface text-foreground shadow-elev-2', className)}
      {...props}
    >
      {children}
    </aside>
  );
}
