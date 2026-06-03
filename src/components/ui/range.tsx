import type { CSSProperties, InputHTMLAttributes } from 'react';
import { cn } from './cn';
import styles from './range.module.css';

type RangeStyle = CSSProperties & {
  '--range-progress'?: string;
  '--range-tick-size'?: string;
  '--range-tick-color'?: string;
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

// Discrete sliders get a ruler: one notch per step. Returns the segment width
// (as a %) for the repeating tick gradient, or null for continuous/large ranges.
function resolveTickSize(props: InputHTMLAttributes<HTMLInputElement>): string | null {
  const min = toNumber(props.min, 0);
  const max = toNumber(props.max, 100);
  const step = toNumber(props.step, 1);
  if (step <= 0) return null;
  const segments = Math.round((max - min) / step);
  if (!Number.isFinite(segments) || segments < 2 || segments > 24) return null;
  return `${100 / segments}%`;
}

export function RangeInput({
  className,
  style,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const tickSize = resolveTickSize(props);
  const rangeStyle: RangeStyle = {
    ...style,
    '--range-progress': `${resolveRangeProgress(props)}%`,
    ...(tickSize
      ? {
          '--range-tick-size': tickSize,
          '--range-tick-color': 'color-mix(in srgb, var(--foreground) 22%, transparent)',
        }
      : {}),
  };

  return <input type="range" className={cn(styles.range, className)} style={rangeStyle} {...props} />;
}
