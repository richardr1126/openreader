import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { variants } from './variants';
import { focusRing, motionColors } from './tokens';

export type IconButtonTone = 'ghost' | 'surface' | 'danger';
export type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export const iconButtonStyles = variants({
  base: cn('inline-flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-50', focusRing, motionColors),
  variants: {
    tone: {
      ghost: 'text-soft hover:bg-accent-wash hover:text-accent',
      surface: 'border border-line bg-surface text-foreground hover:bg-accent-wash hover:text-accent',
      danger: 'text-danger hover:bg-danger-wash',
    },
    size: {
      xs: 'h-5 w-5 rounded-sm text-xs',
      sm: 'h-7 w-7 rounded-md text-xs',
      md: 'h-8 w-8 rounded-md text-sm',
      lg: 'h-10 w-10 rounded-lg text-base',
    },
  },
  defaults: {
    tone: 'ghost',
    size: 'md',
  },
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  tone?: IconButtonTone;
  size?: IconButtonSize;
}>(function IconButton({
  className,
  children,
  tone = 'ghost',
  size = 'md',
  type = 'button',
  ...props
}, ref) {
  return (
    <button ref={ref} type={type} className={iconButtonStyles({ tone, size, className })} {...props}>
      {children}
    </button>
  );
});
