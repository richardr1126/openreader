import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';
import { variants } from './variants';
import { motionColors } from './tokens';

export type InputControlSize = 'sm' | 'md' | 'lg';

export const inputStyles = variants({
  base: cn('w-full border border-line bg-surface-sunken text-foreground placeholder:text-soft focus:border-accent-line focus:outline-none focus:ring-2 focus:ring-accent-line', motionColors),
  variants: {
    size: {
      sm: 'rounded-md px-2 py-1 text-xs',
      md: 'rounded-md px-2.5 py-1.5 text-sm',
      lg: 'rounded-lg px-3 py-2 text-sm',
    },
  },
  defaults: {
    size: 'md',
  },
});

export const inputClass = inputStyles();

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { controlSize?: InputControlSize }>(function Input({
  className,
  controlSize = 'md',
  ...props
}, ref) {
  return <input ref={ref} className={inputStyles({ size: controlSize, className })} {...props} />;
});

export function Textarea({
  className,
  controlSize = 'md',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { controlSize?: InputControlSize }) {
  return <textarea className={inputStyles({ size: controlSize, className })} {...props} />;
}
