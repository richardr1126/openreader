'use client';

import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import type { ComponentProps } from 'react';
import { cn } from './cn';
import { CheckIcon, ChevronRightIcon } from '@/components/icons/Icons';

const listboxButtonClass =
  'relative w-full cursor-pointer rounded-md bg-surface-sunken border border-line py-1.5 pl-2.5 pr-9 text-left text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent-line hover:bg-accent-wash transition-colors duration-fast ease-standard';

const listboxToolbarButtonClass =
  'inline-flex items-center rounded-md border border-line bg-surface px-2 py-1 text-xs text-foreground hover:border-accent-line hover:bg-accent-wash hover:text-accent transition-colors duration-fast ease-standard';

const listboxPopoverButtonClass =
  'inline-flex items-center rounded-md text-foreground hover:bg-accent-wash hover:text-accent focus:outline-none transition-colors duration-fast ease-standard';

const listboxPanelClass =
  'z-50 max-h-60 overflow-y-auto overscroll-contain rounded-md bg-surface p-1 shadow-elev-2 ring-1 ring-line focus:outline-none';

const listboxOptionsClass =
  cn(listboxPanelClass, 'w-[var(--button-width)] [--anchor-gap:0.25rem]');

const listboxCompactOptionsClass =
  'z-50 min-w-[8rem] rounded-md bg-surface p-1 shadow-elev-2 ring-1 ring-line focus:outline-none [--anchor-gap:0.25rem]';

const listboxOptionClass = (active: boolean, selected = false, inset: 'check' | 'none' = 'check') =>
  cn(
    'relative cursor-pointer select-none rounded-sm py-1.5 text-sm',
    inset === 'check' ? 'pl-9 pr-3' : 'px-2.5',
    selected ? 'bg-accent text-background font-medium' : active ? 'bg-accent-wash text-foreground' : 'text-foreground',
  );

const listboxCompactOptionClass = (active: boolean, selected = false) =>
  cn(
    'relative cursor-pointer select-none rounded-sm px-2 py-1 text-xs',
    active
      ? 'bg-accent-wash text-accent'
      : selected
        ? 'bg-surface-sunken text-accent font-medium'
        : 'text-foreground',
  );

export function SharedListboxButton({
  tone = 'default',
  className,
  children,
  ...props
}: ComponentProps<typeof ListboxButton> & {
  tone?: 'default' | 'toolbar' | 'popover' | 'unstyled';
}) {
  const baseClass = tone === 'toolbar'
    ? listboxToolbarButtonClass
    : tone === 'popover'
      ? listboxPopoverButtonClass
    : tone === 'unstyled'
      ? ''
      : listboxButtonClass;
  return (
    <ListboxButton className={cn(baseClass, className)} {...props}>
      {children}
    </ListboxButton>
  );
}

export function SharedListboxOptions({
  tone = 'default',
  className,
  children,
  ...props
}: ComponentProps<typeof ListboxOptions> & {
  tone?: 'default' | 'compact';
}) {
  const baseClass = tone === 'compact' ? listboxCompactOptionsClass : listboxOptionsClass;
  return (
    <ListboxOptions className={cn(baseClass, className)} {...props}>
      {children}
    </ListboxOptions>
  );
}

export function SharedListboxOption({
  tone = 'default',
  inset = 'check',
  itemClassName,
  children,
  ...props
}: Omit<ComponentProps<typeof ListboxOption>, 'className'> & {
  tone?: 'default' | 'compact';
  inset?: 'check' | 'none';
  itemClassName?: string;
}) {
  return (
    <ListboxOption
      className={({ active, selected }: { active: boolean; selected: boolean }) => cn(
        tone === 'compact'
          ? listboxCompactOptionClass(active, selected)
          : listboxOptionClass(active, selected, inset),
        itemClassName,
      )}
      {...props}
    >
      {children}
    </ListboxOption>
  );
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const activeOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <Listbox value={value} onChange={onChange}>
      <SharedListboxButton>
        <span>{activeOption?.label ?? 'Select'}</span>
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-soft">
          <ChevronRightIcon className="h-4 w-4 rotate-90" aria-hidden="true" />
        </span>
      </SharedListboxButton>
      <SharedListboxOptions anchor="bottom">
        {options.map((option) => (
          <SharedListboxOption key={option.value} value={option.value}>
            {({ selected }) => (
              <>
                <span className="absolute left-2 flex items-center text-accent">
                  {selected ? <CheckIcon className="h-4 w-4" aria-hidden="true" /> : null}
                </span>
                <span>{option.label}</span>
              </>
            )}
          </SharedListboxOption>
        ))}
      </SharedListboxOptions>
    </Listbox>
  );
}
