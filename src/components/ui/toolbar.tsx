import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { variants } from './variants';
import { motionColors } from './tokens';

export const toolbarButtonStyles = variants({
  base: cn('inline-flex items-center rounded-md border px-2 py-1 text-xs', motionColors),
  variants: {
    active: {
      true: 'border-accent-line bg-surface-sunken text-accent',
      false: 'border-line bg-surface text-foreground hover:border-accent-line hover:bg-accent-wash hover:text-accent',
    },
  },
  defaults: {
    active: 'false',
  },
});

export function Toolbar({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn('sticky top-0 z-40 w-full border-b border-line-soft bg-surface', className)} {...props}>
      <div className="px-2 sm:px-3 py-1 min-h-10 flex items-center gap-1.5 sm:gap-2">{children}</div>
    </div>
  );
}

export function ToolbarButton({
  active = false,
  className,
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button type={type} className={toolbarButtonStyles({ active: active ? 'true' : 'false', className })} {...props}>
      {children}
    </button>
  );
}

export function ToolbarGroup({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-md border border-line bg-surface p-0.5', className)} {...props}>
      {children}
    </div>
  );
}

export function ToolbarSegment({
  active = false,
  className,
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-6 items-center justify-center rounded-sm text-xs transition-colors duration-base ease-standard',
        active ? 'bg-surface-sunken text-accent' : 'text-soft hover:bg-accent-wash hover:text-accent',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
