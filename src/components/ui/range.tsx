import type { InputHTMLAttributes } from 'react';
import { cn } from './cn';

const rangeInputClass = cn(
  'w-full cursor-pointer appearance-none rounded-lg bg-surface-sunken accent-accent',
  '[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-lg [&::-webkit-slider-runnable-track]:bg-surface-sunken',
  '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent',
  '[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-lg [&::-moz-range-track]:bg-surface-sunken',
  '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent',
);

function rangeInputClassName(className?: string) {
  return cn(rangeInputClass, className);
}

export function RangeInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="range" className={rangeInputClassName(className)} {...props} />;
}
