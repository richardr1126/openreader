'use client';

import { Fragment, type ReactNode } from 'react';
import { Transition } from '@headlessui/react';
import { XCircleIcon } from '@/components/icons/Icons';
import { useReaderSidebarBounds } from '@/hooks/useReaderSidebarBounds';

interface ReaderSidebarShellProps {
  isOpen: boolean;
  onClose: () => void;
  ariaLabel: string;
  title: string;
  children: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
  panelClassName?: string;
}

export function ReaderSidebarShell({
  isOpen,
  onClose,
  ariaLabel,
  title,
  children,
  headerActions,
  footer,
  bodyClassName = 'flex-1 overflow-y-auto px-4 py-4',
  panelClassName = '',
}: ReaderSidebarShellProps) {
  const bounds = useReaderSidebarBounds(isOpen);

  return (
    <Transition show={isOpen} as={Fragment}>
      <div
        className="fixed inset-x-0 z-50 pointer-events-none"
        style={{ top: bounds.top, bottom: bounds.bottom }}
      >
        <Transition.Child
          as={Fragment}
          enter="transition-opacity ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="sm:hidden absolute inset-0 overlay-dim backdrop-blur-sm pointer-events-auto"
          />
        </Transition.Child>

        <Transition.Child
          as={Fragment}
          enter="transition ease-out duration-220"
          enterFrom="translate-x-full"
          enterTo="translate-x-0"
          leave="transition ease-in duration-180"
          leaveFrom="translate-x-0"
          leaveTo="translate-x-full"
        >
          <aside
            role="dialog"
            aria-label={ariaLabel}
            className={`reader-sidebar-panel absolute inset-y-0 right-0 sm:right-3 sm:top-3 sm:bottom-3 pointer-events-auto bg-base border-l sm:border border-offbase shadow-xl sm:rounded-xl flex flex-col ${panelClassName}`}
          >
            <div className="border-b border-offbase px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">{title}</h2>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {headerActions}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  title="Close"
                  className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-offbase bg-base text-muted hover:bg-offbase hover:text-accent transition-colors"
                >
                  <XCircleIcon className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className={bodyClassName}>
              {children}
            </div>

            {footer}
          </aside>
        </Transition.Child>
      </div>
    </Transition>
  );
}
