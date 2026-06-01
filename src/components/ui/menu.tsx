import { MenuItem, MenuItems } from '@headlessui/react';
import type { ComponentProps } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

const menuPanelClass = 'rounded-md border border-line bg-surface p-1 shadow-elev-2 ring-1 ring-line-soft';

export function Menu({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn(menuPanelClass, className)} {...props}>
      {children}
    </div>
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
