'use client';

import type { ReactNode } from 'react';

/**
 * Shared admin panel UI primitives that mirror the DocumentSettings /
 * SettingsModal design language (section cards, toggle rows, standard
 * button shapes). Keep this small and inline — nothing here is meant
 * to be reused outside the admin panel.
 */

export const btnBase =
  'inline-flex items-center justify-center rounded-lg text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transform transition-transform duration-200 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100';
export const btnPrimary = `${btnBase} bg-accent text-background hover:bg-secondary-accent hover:scale-[1.04]`;
export const btnSecondary = `${btnBase} bg-background text-foreground hover:bg-offbase hover:text-accent hover:scale-[1.04]`;
export const btnOutline = `${btnBase} bg-background border border-offbase text-foreground hover:bg-offbase hover:text-accent hover:scale-[1.02]`;
export const btnDanger = `${btnBase} bg-red-600 text-white border border-red-700 hover:bg-red-700 hover:scale-[1.02]`;

// Inputs use `bg-base` so they remain visible regardless of whether the
// surrounding container is `bg-background` (Card) or `bg-base` (Section).
// Using the same `bg-background` as the Card would make the input blend in.
// (Note: never use Tailwind alpha modifiers on these theme variables — they
// resolve to CSS custom properties that don't accept opacity suffixes.)
export const inputClass =
  'w-full rounded-lg bg-base border border-offbase py-1.5 px-3 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent';

export function Section({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-offbase bg-base px-3 py-2.5 space-y-2">
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

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-offbase bg-background px-3 py-2 shadow-sm ${className}`}>
      {children}
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
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  right?: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start gap-2">
        <label className="flex items-start gap-2 flex-1 min-w-0">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
            className="mt-0.5 form-checkbox h-4 w-4 text-accent rounded border-muted disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <span className="space-y-0.5 min-w-0">
            <span className="block text-sm font-medium text-foreground">{label}</span>
            <span className="block text-xs text-muted">{description}</span>
          </span>
        </label>
        {right ? <div className="shrink-0 self-start">{right}</div> : null}
      </div>
    </Card>
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
      {label ? <label className="block text-xs font-medium text-muted">{label}</label> : null}
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
