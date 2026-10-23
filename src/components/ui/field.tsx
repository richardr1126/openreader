'use client';

import { PopoverButton } from '@headlessui/react';
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { InfoCircleIcon } from '@/components/icons/Icons';
import { cn } from './cn';
import { PopoverRoot, PopoverSurface } from './popover';
import { RangeInput } from './range';
import { Switch } from './switch';

export function Field({
  label,
  hint,
  action,
  className,
  children,
}: {
  label?: string;
  hint?: string;
  /** A small link or button on the label's line, such as "Get a key". */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const labelElement = label ? <label className="block text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</label> : null;
  return (
    <div className={cn('space-y-1', className)}>
      {action ? (
        <div className="flex items-center justify-between gap-3">
          {labelElement}
          <span className="text-xs">{action}</span>
        </div>
      ) : labelElement}
      {children}
      {hint ? <p className="text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}

/** A theme-tinted square that holds a row's icon, as in iOS grouped lists. */
export function RowIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-wash text-accent [&>svg]:h-4 [&>svg]:w-4',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * An ⓘ button beside a row label that opens a short explanation, so rows stay
 * one line while the detail remains a tap away.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
      <PopoverRoot className="inline-flex">
        <PopoverButton
          aria-label={`About ${label}`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-faint transition-colors duration-fast ease-standard hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <InfoCircleIcon className="h-4 w-4" />
        </PopoverButton>
        <PopoverSurface anchor="bottom start" className="mt-1 w-72 max-w-[calc(100vw-2rem)] text-xs leading-5 text-soft">
          {children}
        </PopoverSurface>
      </PopoverRoot>
    </span>
  );
}

function RowLabel({ id, label, info }: { id?: string; label: string; info?: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <span id={id} className="text-sm font-medium leading-5 text-foreground">{label}</span>
      {info ? <InfoTip label={label}>{info}</InfoTip> : null}
    </span>
  );
}

/**
 * A labelled setting inside a `Section variant="group"`: text on the left, the
 * control on the right (or below it when `stacked`). `meta` is a quiet line
 * under the description, e.g. where the current value came from; `info` sits
 * behind an ⓘ button beside the label.
 */
export function SettingRow({
  label,
  icon,
  description,
  info,
  meta,
  stacked = false,
  controlClassName = 'w-[min(15rem,60%)]',
  children,
}: {
  label: string;
  icon?: ReactNode;
  description?: ReactNode;
  info?: ReactNode;
  meta?: ReactNode;
  stacked?: boolean;
  controlClassName?: string;
  children: ReactNode;
}) {
  const text = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {icon ? <RowIcon>{icon}</RowIcon> : null}
      <div className="min-w-0 flex-1 space-y-0.5">
        <RowLabel label={label} info={info} />
        {description ? <span className="block text-xs leading-4 text-soft">{description}</span> : null}
        {meta ? <span className="block text-[11px] leading-4 text-faint">{meta}</span> : null}
      </div>
    </div>
  );
  if (stacked) {
    return (
      <div className="space-y-2">
        {text}
        {children}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3">
      {text}
      <div className={cn('shrink-0', controlClassName)}>{children}</div>
    </div>
  );
}

export function ToggleRow({
  label,
  icon,
  description,
  info,
  checked,
  onChange,
  disabled = false,
  meta,
  variant = 'card',
}: {
  label: string;
  icon?: ReactNode;
  description?: string;
  info?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  meta?: ReactNode;
  variant?: 'card' | 'flat' | 'plain';
}) {
  const labelId = useId();
  const descId = useId();
  const rowClass =
    variant === 'plain'
      ? ''
      : variant === 'flat'
        ? 'px-0.5 pt-1 pb-2 border-b border-line-soft last:border-b-0 transition-colors duration-fast ease-standard'
        : 'rounded-md border border-line bg-surface px-2.5 py-1.5 transition-colors duration-fast ease-standard';
  const handleTextToggle = () => {
    if (!disabled) onChange(!checked);
  };
  return (
    <div className={rowClass}>
      <div className={cn('flex gap-2.5', variant === 'plain' || icon ? 'items-center' : 'items-start')}>
        {icon ? <RowIcon className="mr-0.5">{icon}</RowIcon> : null}
        <div
          className={cn('flex-1 min-w-0 space-y-0.5', disabled ? '' : 'cursor-pointer')}
          onClick={handleTextToggle}
        >
          <RowLabel id={labelId} label={label} info={info} />
          {description ? <span id={descId} className="block text-xs leading-4 text-soft">{description}</span> : null}
          {meta ? <span className="block text-[11px] leading-4 text-faint">{meta}</span> : null}
        </div>
        <Switch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          size="md"
          ariaLabelledBy={labelId}
          ariaDescribedBy={description ? descId : undefined}
        />
      </div>
    </div>
  );
}

type RangeFieldProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  description?: string;
  valueWidth?: string;
  formatter?: (value: number) => string;
  onChange: (value: number) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'type' | 'className'>;

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  description,
  valueWidth = 'w-10',
  formatter = (next) => String(next),
  onChange,
  id,
  ...inputProps
}: RangeFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">{label}</label>
        <span className={cn(valueWidth, 'text-sm text-right text-soft tabular-nums')}>
          {formatter(value)}
        </span>
      </div>
      <RangeInput
        id={inputId}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        {...inputProps}
      />
      {description ? <p className="text-xs text-faint">{description}</p> : null}
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
