'use client';

import { useId, type ReactNode } from 'react';

/**
 * Shared compact form primitives used by settings-like surfaces across
 * the app (settings modal, document settings, and admin panels).
 */

export const btnBase =
  'inline-flex items-center justify-center rounded-md text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors transition-transform duration-200 ease-out disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100';
export const btnPrimary = `${btnBase} bg-accent text-background hover:bg-secondary-accent hover:scale-[1.03]`;
export const btnSecondary = `${btnBase} bg-base text-foreground border border-offbase hover:bg-offbase hover:scale-[1.03]`;
export const btnOutline = `${btnBase} bg-background border border-offbase text-foreground hover:bg-base hover:text-accent hover:scale-[1.02]`;
export const btnDanger = `${btnBase} bg-red-600 text-white border border-red-700 hover:bg-red-700 hover:scale-[1.02]`;
export const btnGhost = `${btnBase} bg-transparent text-foreground hover:bg-base hover:text-accent`;

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: btnPrimary,
  secondary: btnSecondary,
  outline: btnOutline,
  danger: btnDanger,
  ghost: btnGhost,
};

const BUTTON_SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs rounded-md',
  sm: 'h-7 px-2.5 text-xs rounded-md',
  md: 'h-8 px-3 text-sm rounded-md',
  lg: 'h-10 px-4 text-base rounded-lg',
  icon: 'h-8 w-8 rounded-md p-0',
};

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  className = '',
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return [BUTTON_VARIANT_CLASS[variant], BUTTON_SIZE_CLASS[size], className].filter(Boolean).join(' ');
}

// Inputs use `bg-base` so they remain visible regardless of whether the
// surrounding container is `bg-background` (Card) or `bg-base` (Section).
// Using the same `bg-background` as the Card would make the input blend in.
// (Note: never use Tailwind alpha modifiers on these theme variables — they
// resolve to CSS custom properties that don't accept opacity suffixes.)
export const inputClass =
  'w-full rounded-md bg-background border border-offbase px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent';

export const listboxButtonClass =
  'relative w-full cursor-pointer rounded-md bg-background border border-offbase py-1.5 pl-2.5 pr-9 text-left text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent hover:bg-base transition-transform duration-200 ease-out hover:scale-[1.01]';
export const listboxOptionsClass =
  'z-50 w-[var(--button-width)] max-h-60 overflow-y-auto overscroll-contain rounded-md bg-background p-1 shadow-lg ring-1 ring-offbase focus:outline-none [--anchor-gap:0.25rem]';
export const listboxOptionClass = (active: boolean) =>
  `relative cursor-pointer select-none rounded-sm py-1.5 pl-9 pr-3 text-sm ${active ? 'bg-offbase text-foreground' : 'text-foreground'}`;

export const segmentedGroupClass =
  'grid gap-1 rounded-full border border-offbase bg-background p-1';
export const segmentedButtonClass = (active: boolean) =>
  `rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors transition-transform duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    active
      ? 'bg-accent text-background hover:scale-[1.01]'
      : 'text-muted hover:bg-base hover:text-foreground hover:scale-[1.02]'
  }`;

export function Section({
  title,
  subtitle,
  children,
  action,
  variant = 'panel',
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  variant?: 'panel' | 'flat';
}) {
  if (variant === 'flat') {
    return (
      <section className="space-y-2 pb-3 border-b border-offbase last:border-b-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {subtitle ? <p className="text-xs text-muted mt-0.5">{subtitle}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
        {children}
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-offbase bg-base overflow-hidden">
      <div className="px-3 py-2 bg-background border-b border-offbase">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {subtitle ? <p className="text-xs text-muted mt-0.5">{subtitle}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </div>
      <div className="px-3 py-2 space-y-2">
        {children}
      </div>
    </section>
  );
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-offbase bg-background px-3 py-2 transition-transform duration-200 ease-out hover:scale-[1.005] ${className}`}>
      {children}
    </div>
  );
}

export type SwitchSize = 'sm' | 'md';

const SWITCH_SIZE: Record<SwitchSize, { track: string; thumb: string; on: string; off: string }> = {
  sm: {
    track: 'h-4 w-7',
    thumb: 'h-3 w-3',
    on: 'translate-x-3',
    off: 'translate-x-0.5',
  },
  md: {
    track: 'h-5 w-9',
    thumb: 'h-4 w-4',
    on: 'translate-x-4',
    off: 'translate-x-0.5',
  },
};

export function Switch({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: SwitchSize;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
}) {
  const s = SWITCH_SIZE[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-offbase transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${s.track} ${
        checked ? 'bg-accent' : 'bg-offbase'
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block rounded-full bg-background shadow-sm ring-0 transition-transform duration-200 ease-out ${s.thumb} ${
          checked ? s.on : s.off
        }`}
      />
    </button>
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
      ? 'px-0.5 pt-1 pb-2 border-b border-offbase last:border-b-0 transition-transform duration-200 ease-out hover:scale-[1.003]'
      : 'rounded-md border border-offbase bg-background px-2.5 py-1.5 transition-transform duration-200 ease-out hover:scale-[1.005]';
  const handleTextToggle = () => {
    if (!disabled) onChange(!checked);
  };
  return (
    <div className={rowClass}>
      <div className="flex items-start gap-2.5">
        <div
          className={`flex-1 min-w-0 space-y-0.5 ${disabled ? '' : 'cursor-pointer'}`}
          onClick={handleTextToggle}
        >
          <span id={labelId} className="block text-sm font-medium leading-5 text-foreground">{label}</span>
          <span id={descId} className="block text-xs leading-4 text-muted">{description}</span>
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
        className={`flex-1 min-w-0 truncate text-xs leading-4 text-foreground select-none transition-colors duration-200 ease-out group-hover:text-accent ${
          disabled ? '' : 'cursor-pointer'
        }`}
      >
        {label}
      </span>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        size="sm"
        ariaLabelledBy={labelId}
      />
    </div>
  );
}

export function Field({
  label,
  hint,
  className = '',
  children,
}: {
  label?: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`space-y-1 ${className}`}>
      {label ? <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</label> : null}
      {children}
      {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'accent' | 'foreground';
  children: ReactNode;
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-accent'
      : tone === 'foreground'
        ? 'text-foreground bg-offbase'
        : 'text-muted bg-offbase';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 ${toneClass}`}>
      {children}
    </span>
  );
}
