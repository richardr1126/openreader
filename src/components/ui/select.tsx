'use client';

import { Listbox, ListboxButton, ListboxOption, ListboxOptions, Transition } from '@headlessui/react';
import { Fragment, type ComponentProps, type Key, type ReactNode } from 'react';
import { cn } from './cn';
import { CheckIcon, ChevronUpDownIcon } from '@/components/icons/Icons';

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

/**
 * Secondary line inside a `Select` option. It inherits the option's text color
 * (dimmed) so it stays legible on the selected accent fill as well as on the
 * hover and resting backgrounds; never give it a fixed `text-muted`/`text-soft`.
 */
export function SelectOptionDetail({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('block text-xs opacity-80', className)}>{children}</span>;
}

export type SelectOption = {
  value: string;
  label: string;
};

export function Select<T = SelectOption>({
  value,
  onChange,
  options,
  getOptionKey,
  renderValue,
  renderOption,
  placeholder = 'Select',
  disabled,
  buttonClassName,
  optionsClassName,
  optionInset = 'check',
  optionItemClassName,
  showCheckmark = true,
  chevronClassName = 'h-5 w-5 text-soft',
}: {
  value: T | undefined;
  onChange: (value: T) => void;
  options: readonly T[];
  getOptionKey?: (option: T) => Key;
  renderValue?: (option: T) => ReactNode;
  renderOption?: (option: T, state: { selected: boolean }) => ReactNode;
  placeholder?: ReactNode;
  disabled?: boolean;
  buttonClassName?: string;
  optionsClassName?: string;
  optionInset?: 'check' | 'none';
  optionItemClassName?: string;
  showCheckmark?: boolean;
  chevronClassName?: string;
}) {
  const defaultKey = (option: T): Key => {
    if (typeof option === 'string' || typeof option === 'number') return option;
    const record = option as Record<string, unknown>;
    return String(record.value ?? record.id ?? record.label);
  };
  const defaultRender = (option: T): ReactNode => {
    if (typeof option === 'string' || typeof option === 'number') return String(option);
    const record = option as Record<string, unknown>;
    return String(record.label ?? record.name ?? record.value ?? record.id ?? '');
  };
  const optionKey = getOptionKey ?? defaultKey;
  const valueRenderer = renderValue ?? defaultRender;
  const optionRenderer = renderOption ?? ((option: T) => valueRenderer(option));

  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <SharedListboxButton className={buttonClassName}>
        <span className="block truncate">{value === undefined ? placeholder : valueRenderer(value)}</span>
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
          <ChevronUpDownIcon className={chevronClassName} aria-hidden="true" />
        </span>
      </SharedListboxButton>
      <Transition
        as={Fragment}
        leave="transition ease-standard duration-fast"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <SharedListboxOptions anchor="bottom start" className={optionsClassName}>
          {options.map((option) => (
            <SharedListboxOption
              key={optionKey(option)}
              value={option}
              inset={optionInset}
              itemClassName={optionItemClassName}
            >
              {({ selected }) => (
                <>
                  {optionRenderer(option, { selected })}
                  {showCheckmark && selected ? (
                    <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-background">
                      <CheckIcon className="h-5 w-5" aria-hidden="true" />
                    </span>
                  ) : null}
                </>
              )}
            </SharedListboxOption>
          ))}
        </SharedListboxOptions>
      </Transition>
    </Listbox>
  );
}
