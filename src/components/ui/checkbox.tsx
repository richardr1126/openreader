import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from './cn';
import { focusRing, motionColors } from './tokens';

export const checkboxClass = cn(
  'h-4 w-4 rounded border-line bg-surface text-accent disabled:cursor-not-allowed disabled:opacity-50',
  focusRing,
  motionColors,
);

export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>
>(function Checkbox({ className, ...props }, ref) {
  return <input ref={ref} type="checkbox" className={cn(checkboxClass, className)} {...props} />;
});
