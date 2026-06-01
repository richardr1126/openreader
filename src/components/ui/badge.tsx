import type { HTMLAttributes, ReactNode } from 'react';
import { variants } from './variants';

export type BadgeTone = 'muted' | 'accent' | 'foreground' | 'danger';

export const badgeStyles = variants({
  base: 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
  variants: {
    tone: {
      muted: 'bg-surface-sunken text-soft',
      accent: 'bg-accent-wash text-accent',
      foreground: 'bg-surface-sunken text-foreground',
      danger: 'bg-danger-wash text-danger',
    },
  },
  defaults: {
    tone: 'muted',
  },
});

export function Badge({
  tone = 'muted',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span className={badgeStyles({ tone, className })} {...props}>
      {children}
    </span>
  );
}
