import type { CSSProperties, InputHTMLAttributes } from 'react';
import { cn } from './cn';

type RangeStyle = CSSProperties & {
  '--range-progress'?: string;
};

function toNumber(value: string | number | readonly string[] | undefined, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function resolveRangeProgress(props: InputHTMLAttributes<HTMLInputElement>): number {
  const min = toNumber(props.min, 0);
  const max = toNumber(props.max, 100);
  const value = toNumber(props.value, min);
  const span = max - min;
  if (span <= 0) return 0;
  const progress = ((value - min) / span) * 100;
  return Math.min(100, Math.max(0, progress));
}

const rangeInputClass = cn(
  'h-6 w-full cursor-pointer appearance-none bg-transparent [--range-track-h:0.5rem] [--range-thumb-h:1.25rem]',
  'focus-visible:outline-none focus-visible:[&::-webkit-slider-thumb]:ring-4 focus-visible:[&::-webkit-slider-thumb]:ring-accent/25',
  'focus-visible:[&::-moz-range-thumb]:ring-4 focus-visible:[&::-moz-range-thumb]:ring-accent/25',
  'disabled:cursor-not-allowed disabled:opacity-60',
  '[&::-webkit-slider-runnable-track]:h-[var(--range-track-h)] [&::-webkit-slider-runnable-track]:rounded-full',
  '[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--secondary-accent)_0%,var(--secondary-accent)_var(--range-progress),color-mix(in_srgb,var(--offbase)_82%,var(--background))_var(--range-progress),color-mix(in_srgb,var(--offbase)_82%,var(--background))_100%)]',
  '[&::-webkit-slider-runnable-track]:shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_10%,transparent)]',
  '[&::-webkit-slider-thumb]:mt-[calc((var(--range-track-h)-var(--range-thumb-h))/2)] [&::-webkit-slider-thumb]:h-[var(--range-thumb-h)] [&::-webkit-slider-thumb]:w-[var(--range-thumb-h)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
  '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[color-mix(in_srgb,var(--background)_78%,white)]',
  '[&::-webkit-slider-thumb]:bg-accent',
  '[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150 [&::-webkit-slider-thumb]:ease-out',
  'active:[&::-webkit-slider-thumb]:scale-[1.07]',
  '[&::-moz-range-track]:h-[var(--range-track-h)] [&::-moz-range-track]:rounded-full [&::-moz-range-track]:border-0',
  '[&::-moz-range-track]:bg-[color-mix(in_srgb,var(--offbase)_82%,var(--background))]',
  '[&::-moz-range-progress]:h-[var(--range-track-h)] [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:border-0 [&::-moz-range-progress]:bg-secondary-accent',
  '[&::-moz-range-thumb]:h-[var(--range-thumb-h)] [&::-moz-range-thumb]:w-[var(--range-thumb-h)] [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2',
  '[&::-moz-range-thumb]:border-[color-mix(in_srgb,var(--background)_78%,white)] [&::-moz-range-thumb]:bg-accent',
  '[&::-moz-range-thumb]:transition-transform [&::-moz-range-thumb]:duration-150 [&::-moz-range-thumb]:ease-out',
  'active:[&::-moz-range-thumb]:scale-[1.07]',
);

function rangeInputClassName(className?: string) {
  return cn(rangeInputClass, className);
}

export function RangeInput({
  className,
  style,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const rangeStyle: RangeStyle = {
    ...style,
    '--range-progress': `${resolveRangeProgress(props)}%`,
  };

  return <input type="range" className={rangeInputClassName(className)} style={rangeStyle} {...props} />;
}
