import {
  Menu as HeadlessMenu,
  MenuButton as HeadlessMenuButton,
  MenuItem,
  MenuItems,
  Transition,
} from '@headlessui/react';
import { Fragment } from 'react';
import type { ComponentProps } from 'react';
import type { ReactNode } from 'react';
import { cn } from './cn';

const menuPanelClass = 'rounded-md border border-line bg-surface p-1 shadow-elev-2 ring-1 ring-line-soft';

export const MenuRoot = HeadlessMenu;
export const MenuTrigger = HeadlessMenuButton;

export function MenuTransition({ children }: { children: ReactNode }) {
  return (
    <Transition
      as={Fragment}
      enter="transition ease-standard duration-fast"
      enterFrom="transform opacity-0 scale-95"
      enterTo="transform opacity-100 scale-100"
      leave="transition ease-standard duration-fast"
      leaveFrom="transform opacity-100 scale-100"
      leaveTo="transform opacity-0 scale-95"
    >
      {children}
    </Transition>
  );
}

function menuItemClass(active: boolean, tone: 'default' | 'danger' = 'default') {
  if (tone === 'danger') {
    return cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-danger', active && 'bg-danger-wash');
  }
  return cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs', active ? 'bg-accent-wash text-accent' : 'text-foreground');
}

export function MenuItemsSurface({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuItems>) {
  return (
    <MenuItems className={cn(menuPanelClass, className)} {...props}>
      {children}
    </MenuItems>
  );
}

export function MenuActionItem({
  tone = 'default',
  activeOverride = false,
  disabled = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<'button'>, 'className' | 'children'> & {
  tone?: 'default' | 'danger';
  activeOverride?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <MenuItem disabled={disabled}>
      {({ active, disabled: itemDisabled }) => (
        <button
          type="button"
          disabled={itemDisabled}
          className={cn(menuItemClass(active || activeOverride, tone), itemDisabled && 'cursor-not-allowed text-faint', className)}
          {...props}
        >
          {children}
        </button>
      )}
    </MenuItem>
  );
}
