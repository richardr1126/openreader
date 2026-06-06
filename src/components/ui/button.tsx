import Link, { type LinkProps } from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { variants } from './variants';
import { focusRing, motionColors } from './tokens';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

const buttonStyles = variants({
  base: cn(
    'inline-flex items-center justify-center font-medium disabled:cursor-not-allowed disabled:opacity-50',
    focusRing,
    motionColors,
  ),
  variants: {
    variant: {
      primary: 'bg-accent text-background hover:bg-secondary-accent',
      secondary: 'border border-line bg-surface text-foreground hover:bg-accent-wash',
      outline: 'border border-line bg-surface-sunken text-foreground hover:bg-accent-wash hover:text-accent',
      danger: 'border border-danger bg-danger text-background hover:bg-danger-strong hover:border-danger-strong',
      ghost: 'bg-transparent text-foreground hover:bg-accent-wash hover:text-accent',
    },
    size: {
      xs: 'h-6 rounded-md px-2 text-xs',
      sm: 'h-7 rounded-md px-2.5 text-xs',
      md: 'h-8 rounded-md px-3 text-sm',
      lg: 'h-10 rounded-lg px-4 text-base',
      icon: 'h-8 w-8 rounded-md p-0 text-sm',
    },
  },
  defaults: {
    variant: 'secondary',
    size: 'md',
  },
});

function buttonClass({
  variant = 'secondary',
  size = 'md',
  className = '',
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return buttonStyles({ variant, size, className });
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  return (
    <button type={type} className={buttonClass({ variant, size, className })} {...props}>
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...props
}: LinkProps & AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  return (
    <Link className={buttonClass({ variant, size, className })} {...props}>
      {children}
    </Link>
  );
}

export function ButtonAnchor({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  return (
    <a className={buttonClass({ variant, size, className })} {...props}>
      {children}
    </a>
  );
}

export function InlineButton({
  className,
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      className={cn('underline hover:text-foreground', focusRing, motionColors, className)}
      {...props}
    >
      {children}
    </button>
  );
}
