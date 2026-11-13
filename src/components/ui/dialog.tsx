'use client';

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
} from 'react';
import { Portal } from '@headlessui/react';
import { raiseAboveModals } from './top-layer';
import { variants } from './variants';
import { cn } from './cn';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export const dialogPanelStyles = variants({
  base: 'w-full rounded-lg border border-line bg-surface text-left align-middle shadow-elev-3 animate-scale-in',
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

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const TitleIdContext = createContext<string | undefined>(undefined);

/**
 * Recently focused elements, newest last. A closing modal returns focus to the
 * newest one still on the page, so a modal opened from a menu item returns
 * focus to the menu's button.
 */
const focusHistory: Element[] = [];
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof Element)) return;
    // Focus inside a popup menu or listbox belongs to the control that opened
    // it, which labels the popup and is where focus goes when the popup closes.
    const popup = event.target.closest('[role="menu"][aria-labelledby], [role="listbox"][aria-labelledby]');
    const opener = popup && document.getElementById(popup.getAttribute('aria-labelledby')!.split(' ')[0]);
    const entry = opener ?? event.target;
    const index = focusHistory.indexOf(entry);
    if (index !== -1) focusHistory.splice(index, 1);
    focusHistory.push(entry);
    if (focusHistory.length > 8) focusHistory.shift();
  }, true);
}

/** Dialogs this module closed, whose queued `close` event is not the browser's. */
const closedHere = new WeakSet<HTMLDialogElement>();

function closeModal(dialog: HTMLDialogElement, returnTo: readonly Element[]) {
  closedHere.add(dialog);
  dialog.close();
  // The browser returns focus to whatever was focused at opening, which may be
  // a menu item on its way out; return it to the control that remains instead.
  const target = [...returnTo].reverse().find((element) => element.isConnected && !dialog.contains(element));
  if (target instanceof HTMLElement || target instanceof SVGElement) target.focus({ preventScroll: true });
}

/**
 * A modal on the native `<dialog>` element. The browser owns the top layer
 * and page inertness; closing returns focus through `focusHistory`. Nothing closes it behind the
 * caller's back: it asks `onClose` on Escape or on a press that starts and ends
 * on the backdrop, and otherwise follows `open`.
 */
function NativeModal({
  open,
  onClose,
  onKeyDown,
  labelledBy,
  overlayClassName,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  labelledBy?: string;
  overlayClassName: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  const onCloseRef = useRef(onClose);
  const pressOnBackdropRef = useRef(false);
  const returnFocusRef = useRef<Element[]>([]);
  // Content mounts only once the dialog is showing, so `autoFocus` lands.
  const [shown, setShown] = useState(false);

  useLayoutEffect(() => {
    openRef.current = open;
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        returnFocusRef.current = [...focusHistory];
        dialog.showModal();
        raiseAboveModals();
      }
      setShown(true);
    } else {
      if (dialog.open) closeModal(dialog, returnFocusRef.current);
      setShown(false);
    }
  }, [open]);

  // A modal removed while open closes first, so focus still returns.
  useLayoutEffect(() => {
    const dialog = ref.current;
    const returnFocus = returnFocusRef;
    return () => {
      if (dialog?.open) closeModal(dialog, returnFocus.current);
    };
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!shown || !dialog) return;
    const active = document.activeElement;
    if (active === dialog || !dialog.contains(active)) {
      dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
  }, [shown]);

  const isBackdrop = (target: EventTarget | null) => {
    const dialog = ref.current;
    if (!dialog || !(target instanceof Element)) return false;
    if (target !== dialog && !(target.hasAttribute('data-modal-backdrop') && target.closest('dialog') === dialog)) {
      return false;
    }
    // A press outside an open listbox or menu only closes that popup.
    return !dialog.querySelector(':scope > [data-headlessui-portal]');
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-transparent p-0 text-foreground backdrop:bg-transparent"
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onClose={(event) => {
        // A close this module made fires late, perhaps after a reopening.
        if (closedHere.delete(event.currentTarget)) return;
        // The browser may close a modal itself, as on a repeated Escape. Ask the
        // caller, and reopen if it keeps the modal open.
        if (!openRef.current) return;
        onCloseRef.current();
        requestAnimationFrame(() => {
          const dialog = ref.current;
          if (openRef.current && dialog?.isConnected && !dialog.open) dialog.showModal();
        });
      }}
      onPointerDown={(event) => {
        pressOnBackdropRef.current = isBackdrop(event.target);
      }}
      onClick={(event) => {
        const fromBackdrop = pressOnBackdropRef.current;
        pressOnBackdropRef.current = false;
        if (fromBackdrop && isBackdrop(event.target)) onCloseRef.current();
      }}
      onKeyDown={onKeyDown}
    >
      {/* Always present: Headless UI portals (listboxes, menus) mount into the
          dialog, and remove their container once it has no children left. */}
      <div data-modal-backdrop className={cn('fixed inset-0 overlay-dim backdrop-blur-sm', shown && 'animate-fade-in')} />
      {shown ? (
        <Portal.Group target={ref}>
          <div data-modal-backdrop className={overlayClassName}>
            {children}
          </div>
        </Portal.Group>
      ) : null}
    </dialog>
  );
}

export function ModalFrame({
  open,
  onClose,
  children,
  size = 'md',
  panelClassName,
  panelTestId,
  onKeyDown,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: DialogSize;
  panelClassName?: string;
  panelTestId?: string;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
}) {
  const titleId = useId();
  return (
    <NativeModal
      open={open}
      onClose={onClose}
      onKeyDown={onKeyDown}
      labelledBy={titleId}
      overlayClassName="relative flex min-h-full items-start justify-center p-4 pt-6 text-center sm:items-center sm:pt-4"
    >
      <TitleIdContext.Provider value={titleId}>
        <div data-testid={panelTestId} className={dialogPanelStyles({ size, className: panelClassName })}>
          {children}
        </div>
      </TitleIdContext.Provider>
    </NativeModal>
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
    <h3 id={useContext(TitleIdContext)} className={cn('text-lg font-semibold leading-6 text-foreground', className)}>
      {children}
    </h3>
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
  return (
    <NativeModal
      open={open}
      onClose={onClose}
      overlayClassName={cn('fixed inset-y-0 flex max-w-full', side === 'left' ? 'left-0' : 'right-0')}
    >
      <div
        className={cn(
          'h-full bg-surface shadow-elev-3',
          side === 'left' ? 'animate-slide-in-left' : 'animate-slide-in-right',
          className,
        )}
      >
        {children}
      </div>
    </NativeModal>
  );
}
