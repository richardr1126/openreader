import { cn } from './cn';
import { variants } from './variants';

export type DropzoneVariant = 'default' | 'compact';

export const dropzoneStyles = variants({
  base: 'group w-full cursor-pointer border-dashed text-foreground transition-colors duration-base ease-standard disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  variants: {
    variant: {
      default: 'rounded-lg border-2 px-3 py-5',
      compact: 'rounded-md border px-2 py-1',
    },
    active: {
      true: 'border-accent bg-surface text-accent',
      false: 'border-line bg-transparent hover:border-accent hover:bg-accent-wash hover:text-accent',
    },
  },
  defaults: {
    variant: 'default',
    active: 'false',
  },
});

export function dropzoneSurfaceClass({
  variant = 'default',
  active = false,
  disabled = false,
  className,
}: {
  variant?: DropzoneVariant;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return dropzoneStyles({
    variant,
    active: active ? 'true' : 'false',
    className: cn(disabled && 'pointer-events-none cursor-not-allowed opacity-50', className),
  });
}
