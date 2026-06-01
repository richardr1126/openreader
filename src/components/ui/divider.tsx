import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export function Divider({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('border-t border-line-soft', className)} {...props} />;
}
