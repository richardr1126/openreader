import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { variants } from './variants';
import { motionSurface } from './tokens';

export type SurfaceTone = 'default' | 'solid' | 'sunken' | 'transparent';
export type SurfaceElevation = 'none' | '1' | '2' | '3';
export type SurfaceRadius = 'sm' | 'md' | 'lg' | 'pill';

export const surfaceStyles = variants({
  base: 'border text-foreground',
  variants: {
    tone: {
      default: 'border-line bg-surface',
      solid: 'border-line bg-surface-solid',
      sunken: 'border-line bg-surface-sunken',
      transparent: 'border-transparent bg-transparent',
    },
    elevation: {
      none: '',
      '1': 'shadow-elev-1',
      '2': 'shadow-elev-2',
      '3': 'shadow-elev-3',
    },
    radius: {
      sm: 'rounded-sm',
      md: 'rounded-md',
      lg: 'rounded-lg',
      pill: 'rounded-pill',
    },
  },
  defaults: {
    tone: 'default',
    elevation: 'none',
    radius: 'lg',
  },
});

export function Surface({
  children,
  className,
  tone = 'default',
  elevation = 'none',
  radius = 'lg',
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  tone?: SurfaceTone;
  elevation?: SurfaceElevation;
  radius?: SurfaceRadius;
}) {
  return (
    <div className={surfaceStyles({ tone, elevation, radius, className })} {...props}>
      {children}
    </div>
  );
}

export function Panel({
  children,
  className,
  elevation = '1',
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  elevation?: SurfaceElevation;
}) {
  return (
    <Surface elevation={elevation} className={cn('overflow-hidden', className)} {...props}>
      {children}
    </Surface>
  );
}

export function Card({
  children,
  className,
  interactive = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  interactive?: boolean;
}) {
  return (
    <Surface
      className={cn('px-3 py-2', interactive && motionSurface, className)}
      {...props}
    >
      {children}
    </Surface>
  );
}
