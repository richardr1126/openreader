import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { forwardRef, type ComponentProps } from 'react';
import { cn } from './cn';
import { IconButton } from './icon-button';

const popoverPanelClass = cn(
  'z-50 rounded-md border border-line bg-surface shadow-elev-2 focus:outline-none',
);

export const PopoverRoot = Popover;

const popoverTriggerClass = cn(
  'inline-flex items-center rounded-md text-foreground hover:bg-accent-wash hover:text-accent focus:outline-none transition-colors duration-fast ease-standard',
);

export const PopoverTrigger = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof PopoverButton>
>(function PopoverTrigger({ className, children, ...props }, ref) {
  return (
    <PopoverButton ref={ref} className={cn(popoverTriggerClass, className)} {...props}>
      {children}
    </PopoverButton>
  );
});

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
  flush = false,
  className,
  children,
  ...props
}: ComponentProps<typeof PopoverPanel> & {
  /** Rows that run edge to edge, such as a menu, set their own padding. */
  flush?: boolean;
}) {
  return (
    <PopoverPanel className={cn(popoverPanelClass, !flush && 'p-3', className)} {...props}>
      {children}
    </PopoverPanel>
  );
}
