'use client';

import { Fragment, type KeyboardEventHandler, type ReactNode } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { variants } from './variants';
import { cn } from './cn';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export const dialogPanelStyles = variants({
  base: 'w-full transform rounded-lg border border-line bg-surface text-left align-middle shadow-elev-3 transition',
  variants: {
    size: {
      sm: 'max-w-md p-5',
      md: 'max-w-md p-6',
      lg: 'max-w-2xl p-6',
      xl: 'max-w-4xl overflow-hidden',
    },
  },
  defaults: {
    size: 'md',
  },
});

export function DialogShell({
  children,
  className,
  size = 'md',
}: {
  children: ReactNode;
  className?: string;
  size?: DialogSize;
}) {
  return <div className={dialogPanelStyles({ size, className })}>{children}</div>;
}

export function ModalFrame({
  open,
  onClose,
  children,
  size = 'md',
  className,
  panelClassName,
  panelTestId,
  onKeyDown,
  afterLeave,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: DialogSize;
  className?: string;
  panelClassName?: string;
  panelTestId?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  afterLeave?: () => void;
}) {
  return (
    <Transition appear show={open} as={Fragment} afterLeave={afterLeave}>
      <Dialog as="div" role={undefined} className={cn('relative z-50', className)} onClose={onClose} onKeyDown={onKeyDown}>
        <TransitionChild
          as={Fragment}
          enter="ease-standard duration-slow"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-standard duration-base"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 overlay-dim backdrop-blur-sm" />
        </TransitionChild>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-start justify-center p-4 pt-6 text-center sm:items-center sm:pt-4">
            <TransitionChild
              as={Fragment}
              enter="ease-standard duration-slow"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-standard duration-base"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel data-testid={panelTestId} className={dialogPanelStyles({ size, className: panelClassName })}>
                {children}
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}

export function ModalTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogTitle as="h3" className={cn('text-lg font-semibold leading-6 text-foreground', className)}>
      {children}
    </DialogTitle>
  );
}

export function DrawerFrame({
  open,
  onClose,
  children,
  side = 'left',
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  side?: 'left' | 'right';
  className?: string;
}) {
  const sideClass = side === 'left' ? 'left-0' : 'right-0';
  const enterFrom = side === 'left' ? '-translate-x-full' : 'translate-x-full';
  const leaveTo = enterFrom;

  return (
    <Transition show={open} as={Fragment}>
      <Dialog onClose={onClose} className="relative z-40">
        <TransitionChild
          as={Fragment}
          enter="transition-opacity duration-fast"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity duration-fast"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 overlay-dim backdrop-blur-sm" />
        </TransitionChild>
        <div className={cn('fixed inset-y-0 flex max-w-full', sideClass)}>
          <TransitionChild
            as={Fragment}
            enter="transition-transform duration-base ease-standard"
            enterFrom={enterFrom}
            enterTo="translate-x-0"
            leave="transition-transform duration-fast ease-standard"
            leaveFrom="translate-x-0"
            leaveTo={leaveTo}
          >
            <DialogPanel className={cn('h-full bg-surface shadow-elev-3', className)}>
              {children}
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}
