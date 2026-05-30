'use client';

import { Dialog, DialogPanel, Transition, TransitionChild } from '@headlessui/react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';

interface FinderWindowProps {
  toolbar: ReactNode;
  sidebar: ReactNode;
  statusBar: ReactNode;
  children: ReactNode;
  /** Controlled sidebar open/closed state (drives mobile drawer + desktop collapse). */
  sidebarOpen: boolean;
  /** Handles close requests from mobile drawer interactions (backdrop tap, Esc). */
  onRequestSidebarClose?: () => void;
}

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

/**
 * Finder-style file pane: sidebar + toolbar + content + status bar.
 * No separate window chrome — it sits flush under the existing app header.
 */
export function FinderWindow({
  toolbar,
  sidebar,
  statusBar,
  children,
  sidebarOpen,
  onRequestSidebarClose,
}: FinderWindowProps) {
  const isNarrow = useIsNarrow();

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden">
      {toolbar}

      <div className="flex flex-1 min-h-0">
        {!isNarrow && sidebarOpen && (
          <div className="h-full">{sidebar}</div>
        )}

        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {children}
        </div>
      </div>

      {statusBar}

      {/* Mobile drawer */}
      <Transition show={isNarrow && sidebarOpen} as={Fragment}>
        <Dialog
          onClose={onRequestSidebarClose ?? (() => undefined)}
          className="relative z-40 md:hidden"
        >
          <TransitionChild
            as={Fragment}
            enter="transition-opacity duration-150"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity duration-100"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
          </TransitionChild>
          <div className="fixed inset-y-0 left-0 flex max-w-full">
            <TransitionChild
              as={Fragment}
              enter="transition-transform duration-200 ease-out"
              enterFrom="-translate-x-full"
              enterTo="translate-x-0"
              leave="transition-transform duration-150 ease-in"
              leaveFrom="translate-x-0"
              leaveTo="-translate-x-full"
            >
              <DialogPanel
                className="w-[80vw] max-w-[280px] h-full bg-base shadow-xl"
              >
                {sidebar}
              </DialogPanel>
            </TransitionChild>
          </div>
        </Dialog>
      </Transition>
    </div>
  );
}
