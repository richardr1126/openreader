import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import type { ComponentProps } from 'react';
import { cn } from './cn';
import { IconButton } from './icon-button';

const popoverPanelClass = cn(
  'z-50 rounded-md border border-line bg-surface p-3 shadow-elev-2 focus:outline-none',
);

export const PopoverRoot = Popover;

const popoverTriggerClass = cn(
  'inline-flex items-center rounded-md text-foreground hover:bg-accent-wash hover:text-accent focus:outline-none transition-colors duration-fast ease-standard',
);

export function PopoverTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof PopoverButton>) {
  return (
    <PopoverButton className={cn(popoverTriggerClass, className)} {...props}>
      {children}
    </PopoverButton>
  );
}

export function PopoverIconTrigger({
  children,
  ...props
}: ComponentProps<typeof IconButton>) {
  return (
    <PopoverButton as={IconButton} {...props}>
      {children}
    </PopoverButton>
  );
}

export function PopoverSurface({
  className,
  children,
  ...props
}: ComponentProps<typeof PopoverPanel>) {
  return (
    <PopoverPanel className={cn(popoverPanelClass, className)} {...props}>
      {children}
    </PopoverPanel>
  );
}
