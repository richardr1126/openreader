import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { focusRing, motionColors } from './tokens';

export function SidebarNav({
  children,
  className,
  layout = 'stack',
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  layout?: 'stack' | 'grid';
}) {
  return (
    <div
      className={cn(
        layout === 'grid' ? 'grid grid-cols-2 gap-1' : 'flex flex-col gap-0.5',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function SidebarNavGroup({
  children,
  action,
  className,
  isFirst = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  action?: ReactNode;
  isFirst?: boolean;
}) {
  return (
    <div
      className={cn(
        'px-2 pb-1 text-[10px] uppercase tracking-[0.08em] text-soft font-semibold leading-none flex items-center justify-between',
        isFirst ? 'pt-1.5' : 'pt-3',
        className,
      )}
      {...props}
    >
      <span>{children}</span>
      {action ? <span className="inline-flex shrink-0 items-center leading-none">{action}</span> : null}
    </div>
  );
}

export function sidebarNavItemClass({
  active = false,
  compact = false,
  isDropTarget = false,
  className,
}: {
  active?: boolean;
  compact?: boolean;
  isDropTarget?: boolean;
  className?: string;
} = {}) {
  return cn(
    'group w-full min-w-0 border text-left font-medium',
    'inline-flex items-center',
    focusRing,
    motionColors,
    compact ? 'gap-1.5 rounded-md px-2 py-1 text-xs' : 'gap-2 rounded-md px-2.5 py-1.5 text-sm',
    active
      ? 'border-accent-line bg-surface-sunken text-accent'
      : 'border-transparent bg-transparent text-foreground hover:border-accent-line hover:bg-accent-wash hover:text-accent',
    isDropTarget ? 'ring-1 ring-accent-line' : '',
    className,
  );
}

export function sidebarNavIconClass({
  active = false,
  compact = false,
}: {
  active?: boolean;
  compact?: boolean;
} = {}) {
  return cn(
    'shrink-0 inline-flex items-center justify-center transition-colors duration-base',
    compact ? 'h-4 w-4' : 'h-5 w-5',
    active ? 'text-accent' : 'text-soft group-hover:text-accent',
  );
}

function SidebarNavItemContent({
  active = false,
  icon,
  label,
  count,
  countClassName,
  trailing,
  compact = false,
  children,
}: {
  active?: boolean;
  icon?: ReactNode;
  label?: ReactNode;
  count?: number;
  countClassName?: string;
  trailing?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      {icon ? (
        <span className={sidebarNavIconClass({ active, compact })}>
          {icon}
        </span>
      ) : null}
      {label ?? children ? <span className="min-w-0 flex-1 truncate">{label ?? children}</span> : null}
      {typeof count === 'number' && count > 0 ? (
        <span className={cn('text-[10px] text-soft tabular-nums transition-transform duration-base ease-standard', countClassName)}>
          {count}
        </span>
      ) : null}
      {trailing}
    </>
  );
}

export function SidebarNavItem({
  active = false,
  icon,
  label,
  count,
  countClassName,
  trailing,
  isDropTarget = false,
  className,
  compact = false,
  type = 'button',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  icon?: ReactNode;
  label?: ReactNode;
  count?: number;
  countClassName?: string;
  trailing?: ReactNode;
  isDropTarget?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type={type}
      className={sidebarNavItemClass({ active, compact, isDropTarget, className })}
      {...props}
    >
      <SidebarNavItemContent
        active={active}
        compact={compact}
        icon={icon}
        label={label}
        count={count}
        countClassName={countClassName}
        trailing={trailing}
      >
        {children}
      </SidebarNavItemContent>
    </button>
  );
}

export const SidebarNavLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & {
  active?: boolean;
  icon?: ReactNode;
  label?: ReactNode;
  count?: number;
  countClassName?: string;
  trailing?: ReactNode;
  isDropTarget?: boolean;
  compact?: boolean;
}>(function SidebarNavLink({
  active = false,
  icon,
  label,
  count,
  countClassName,
  trailing,
  isDropTarget = false,
  className,
  compact = false,
  children,
  ...props
}, ref) {
  return (
    <a
      ref={ref}
      className={sidebarNavItemClass({ active, compact, isDropTarget, className })}
      {...props}
    >
      <SidebarNavItemContent
        active={active}
        compact={compact}
        icon={icon}
        label={label}
        count={count}
        countClassName={countClassName}
        trailing={trailing}
      >
        {children}
      </SidebarNavItemContent>
    </a>
  );
});
