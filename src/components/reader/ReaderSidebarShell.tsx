'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Transition } from '@headlessui/react';
import { XCircleIcon } from '@/components/icons/Icons';
import { useReaderSidebarBounds } from '@/hooks/useReaderSidebarBounds';
import { IconButton, Tooltip } from '@/components/ui';

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
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [interactive, setInteractive] = useState(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    openerRef.current = opener;
    return () => {
      // Return focus from a closing panel, but not from a control the user chose.
      // Only the closing panel can hold focus here: another takes it once settled.
      const active = document.activeElement;
      if (active === document.body || active?.closest('[data-reader-sidebar-panel]')) {
        if (opener?.isConnected) opener.focus();
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !interactive) return;
    // Focus only once the panel has reached its final position and is not inert.
    const frame = requestAnimationFrame(() => {
      // Keep an autofocus field or a control the user chose while the panel entered.
      const active = document.activeElement;
      if (active !== document.body && active !== openerRef.current) return;
      closeRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, interactive]);

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
            tabIndex={-1}
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
          beforeEnter={() => setInteractive(false)}
          afterEnter={() => setInteractive(true)}
          beforeLeave={() => setInteractive(false)}
        >
          <aside
            data-reader-sidebar-panel
            role="dialog"
            aria-label={ariaLabel}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }}
            className={`reader-sidebar-panel absolute inset-y-0 right-0 sm:right-3 sm:top-3 sm:bottom-3 pointer-events-auto bg-surface border-l sm:border border-line shadow-elev-3 sm:rounded-lg flex flex-col ${panelClassName}`}
          >
            {/* A delayed animation can look stationary before it starts. Keep the
                controls inert until it settles so a press cannot lose its release
                as the panel slides; the panel itself still takes the press, so it
                cannot fall through to the backdrop or the reader. */}
            <div inert={!isOpen || !interactive} className="contents">
              <div className="border-b border-line-soft px-4 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground">{title}</h2>
                  {subtitle ? <p className="mt-0.5 text-xs text-soft">{subtitle}</p> : null}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {headerActions}
                  <Tooltip label="Close" shortcut="Esc">
                    <IconButton
                      ref={closeRef}
                      onClick={onClose}
                      aria-label="Close"
                      tone="surface"
                      className="text-soft"
                    >
                      <XCircleIcon className="w-4 h-4" />
                    </IconButton>
                  </Tooltip>
                </div>
              </div>

              <div className={bodyClassName}>
                {children}
              </div>

              {footer}
            </div>
          </aside>
        </Transition.Child>
      </div>
    </Transition>
  );
}
