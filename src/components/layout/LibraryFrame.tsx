'use client';

import { Dialog, DialogPanel, Transition, TransitionChild } from '@headlessui/react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

const NARROW_QUERY = '(max-width: 767px)';

export function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(NARROW_QUERY).matches : false,
  );
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
      <LibrarySidebarDrawer open={isNarrow && sidebarOpen} onClose={onRequestSidebarClose}>
        {sidebar}
      </LibrarySidebarDrawer>
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
    <Transition show={open} as={Fragment}>
      <Dialog onClose={onClose ?? (() => undefined)} className="relative z-40 md:hidden">
        <TransitionChild
          as={Fragment}
          enter="transition-opacity duration-fast"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity duration-fast"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        </TransitionChild>
        <div className="fixed inset-y-0 left-0 flex max-w-full">
          <TransitionChild
            as={Fragment}
            enter="transition-transform duration-base ease-standard"
            enterFrom="-translate-x-full"
            enterTo="translate-x-0"
            leave="transition-transform duration-fast ease-standard"
            leaveFrom="translate-x-0"
            leaveTo="-translate-x-full"
          >
            <DialogPanel className="h-full w-[80vw] max-w-[280px] bg-surface shadow-elev-3">
              {children}
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}
