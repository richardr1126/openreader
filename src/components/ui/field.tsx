'use client';

import { useId, type ReactNode } from 'react';
import { cn } from './cn';
import { Switch } from './switch';

export function Field({
  label,
  hint,
  className,
  children,
}: {
  label?: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      {label ? <label className="block text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</label> : null}
      {children}
      {hint ? <p className="text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  right,
  variant = 'card',
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  right?: ReactNode;
  variant?: 'card' | 'flat';
}) {
  const labelId = useId();
  const descId = useId();
  const rowClass =
    variant === 'flat'
      ? 'px-0.5 pt-1 pb-2 border-b border-line-soft last:border-b-0 transition-colors duration-fast ease-standard'
      : 'rounded-md border border-line bg-surface px-2.5 py-1.5 transition-colors duration-fast ease-standard';
  const handleTextToggle = () => {
    if (!disabled) onChange(!checked);
  };
  return (
    <div className={rowClass}>
      <div className="flex items-start gap-2.5">
        <div
          className={cn('flex-1 min-w-0 space-y-0.5', disabled ? '' : 'cursor-pointer')}
          onClick={handleTextToggle}
        >
          <span id={labelId} className="block text-sm font-medium leading-5 text-foreground">{label}</span>
          <span id={descId} className="block text-xs leading-4 text-soft">{description}</span>
        </div>
        {right ? <div className="shrink-0 self-start pl-1.5">{right}</div> : null}
        <Switch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          size="md"
          ariaLabelledBy={labelId}
          ariaDescribedBy={descId}
        />
      </div>
    </div>
  );
}

export function CheckItem({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const handleTextToggle = () => {
    if (!disabled) onChange(!checked);
  };
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 group">
      <span
        id={labelId}
        onClick={handleTextToggle}
        className={cn(
          'flex-1 min-w-0 truncate text-xs leading-4 text-foreground select-none transition-colors duration-fast ease-standard group-hover:text-accent',
          disabled ? '' : 'cursor-pointer',
        )}
      >
        {label}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} size="sm" ariaLabelledBy={labelId} />
    </div>
  );
}
