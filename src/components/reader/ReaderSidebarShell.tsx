'use client';

import { Fragment, type ReactNode } from 'react';
import { Transition } from '@headlessui/react';
import { XCircleIcon } from '@/components/icons/Icons';
import { useReaderSidebarBounds } from '@/hooks/useReaderSidebarBounds';
import { IconButton } from '@/components/ui';

interface ReaderSidebarShellProps {
  isOpen: boolean;
  onClose: () => void;
  ariaLabel: string;
  title: string;
  subtitle?: string;
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
  subtitle,
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
          enter="transition-opacity ease-standard duration-base"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity ease-standard duration-fast"
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
          enter="transition ease-standard duration-base"
          enterFrom="translate-x-full"
          enterTo="translate-x-0"
          leave="transition ease-standard duration-base"
          leaveFrom="translate-x-0"
          leaveTo="translate-x-full"
        >
          <aside
            role="dialog"
            aria-label={ariaLabel}
            className={`reader-sidebar-panel absolute inset-y-0 right-0 sm:right-3 sm:top-3 sm:bottom-3 pointer-events-auto bg-surface border-l sm:border border-line shadow-elev-3 sm:rounded-lg flex flex-col ${panelClassName}`}
          >
            <div className="border-b border-line-soft px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">{title}</h2>
                {subtitle ? <p className="mt-0.5 text-xs text-soft">{subtitle}</p> : null}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {headerActions}
                <IconButton
                  onClick={onClose}
                  aria-label="Close"
                  title="Close"
                  tone="surface"
                  className="text-soft"
                >
                  <XCircleIcon className="w-4 h-4" />
                </IconButton>
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
