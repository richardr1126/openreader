'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { DrawerFrame } from '@/components/ui';

const NARROW_QUERY = '(max-width: 767px)';

export function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isNarrow;
}

export function LibraryFrame({
  toolbar,
  sidebar,
  statusBar,
  children,
  sidebarOpen,
  onRequestSidebarClose,
  className,
}: {
  toolbar: ReactNode;
  sidebar: ReactNode;
  statusBar: ReactNode;
  children: ReactNode;
  sidebarOpen: boolean;
  onRequestSidebarClose?: () => void;
  className?: string;
}) {
  const isNarrow = useIsNarrow();

  return (
    <div className={cn('flex h-full w-full flex-col overflow-hidden bg-surface-sunken', className)}>
      {toolbar}
      <div className="flex flex-1 min-h-0">
        {!isNarrow && sidebarOpen && <div className="h-full">{sidebar}</div>}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">{children}</div>
      </div>
      {statusBar}
      {isNarrow && (
        <LibrarySidebarDrawer open={sidebarOpen} onClose={onRequestSidebarClose}>
          {sidebar}
        </LibrarySidebarDrawer>
      )}
    </div>
  );
}

function LibrarySidebarDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="md:hidden">
      <DrawerFrame open={open} onClose={onClose ?? (() => undefined)} side="left" className="w-[80vw] max-w-[280px]">
        {children}
      </DrawerFrame>
    </div>
  );
}
