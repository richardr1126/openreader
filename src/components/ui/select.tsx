'use client';

import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { cn } from './cn';

export const listboxButtonClass =
  'relative w-full cursor-pointer rounded-md bg-surface-sunken border border-line py-1.5 pl-2.5 pr-9 text-left text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent-line hover:bg-accent-wash transition-colors duration-fast ease-standard';

export const listboxOptionsClass =
  'z-50 w-[var(--button-width)] max-h-60 overflow-y-auto overscroll-contain rounded-md bg-surface p-1 shadow-elev-2 ring-1 ring-line focus:outline-none [--anchor-gap:0.25rem]';

export const listboxOptionClass = (active: boolean) =>
  cn('relative cursor-pointer select-none rounded-sm py-1.5 pl-9 pr-3 text-sm', active ? 'bg-accent-wash text-foreground' : 'text-foreground');

export const segmentedGroupClass = 'grid gap-1 rounded-full border border-line bg-surface-sunken p-1';

export const segmentedButtonClass = (active: boolean) =>
  cn(
    'rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors duration-fast ease-standard focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    active ? 'bg-accent text-background' : 'text-soft hover:bg-accent-wash hover:text-foreground',
  );

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
      <ListboxButton className={listboxButtonClass}>
        <span>{activeOption?.label ?? 'Select'}</span>
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-soft">v</span>
      </ListboxButton>
      <ListboxOptions anchor="bottom" className={listboxOptionsClass}>
        {options.map((option) => (
          <ListboxOption key={option.value} value={option.value} className={({ active }) => listboxOptionClass(active)}>
            {({ selected }) => (
              <>
                <span className="absolute left-2 text-accent">{selected ? '*' : ''}</span>
                <span>{option.label}</span>
              </>
            )}
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
