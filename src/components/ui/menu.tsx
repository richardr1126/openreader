import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export function Menu({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn('rounded-md border border-line bg-surface p-1 shadow-elev-2 ring-1 ring-line-soft', className)} {...props}>
      {children}
    </div>
  );
}

export function MenuItemClass(active: boolean, tone: 'default' | 'danger' = 'default') {
  if (tone === 'danger') {
    return cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-danger', active && 'bg-danger-wash');
  }
  return cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs', active ? 'bg-accent-wash text-accent' : 'text-foreground');
}
