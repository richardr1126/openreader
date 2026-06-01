import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export function AppShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('app-shell h-dvh flex flex-col bg-background overflow-hidden', className)}>
      {children}
    </div>
  );
}

export function AppMain({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn('flex-1 min-h-0 flex flex-col', className)}>{children}</main>;
}
