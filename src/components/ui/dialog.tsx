import type { ReactNode } from 'react';
import { variants } from './variants';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export const dialogPanelStyles = variants({
  base: 'w-full transform rounded-lg border border-line bg-surface text-left align-middle shadow-elev-3 transition',
  variants: {
    size: {
      sm: 'max-w-md p-5',
      md: 'max-w-md p-6',
      lg: 'max-w-2xl p-6',
      xl: 'max-w-4xl overflow-hidden',
    },
  },
  defaults: {
    size: 'md',
  },
});

export function DialogShell({
  children,
  className,
  size = 'md',
}: {
  children: ReactNode;
  className?: string;
  size?: DialogSize;
}) {
  return <div className={dialogPanelStyles({ size, className })}>{children}</div>;
}
