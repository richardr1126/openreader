'use client';

import { Fragment } from 'react';
import { Listbox, Transition } from '@headlessui/react';
import { CheckIcon, ChevronUpDownIcon } from '@/components/icons/Icons';
import { SharedListboxButton, SharedListboxOption, SharedListboxOptions } from '@/components/ui';
import { isLocalTtsProviderType, type TtsProviderId } from '@openreader/tts/provider-catalog';
import { ProviderLogo } from './provider-brands';

export interface ProviderSelectOption {
  id: string;
  name: string;
  providerType: TtsProviderId;
}

const GROUPS = [
  { label: 'Local models', local: true },
  { label: 'External providers', local: false },
] as const;

/** A shared-provider picker, local models first, each provider with its logo. */
export function ProviderSelect({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
}: {
  value: ProviderSelectOption | undefined;
  options: readonly ProviderSelectOption[];
  onChange: (option: ProviderSelectOption) => void;
  'aria-label'?: string;
}) {
  const groups = GROUPS
    .map((group) => ({
      label: group.label,
      options: options.filter((option) => isLocalTtsProviderType(option.providerType) === group.local),
    }))
    .filter((group) => group.options.length > 0);
  const labelled = groups.length > 1;

  return (
    <Listbox value={value} by="id" onChange={onChange}>
      <SharedListboxButton aria-label={ariaLabel}>
        {value ? (
          <span className="flex min-w-0 items-center gap-2">
            <ProviderLogo providerType={value.providerType} size="sm" />
            <span className="truncate">{value.name}</span>
          </span>
        ) : (
          <span className="block truncate text-soft">Select</span>
        )}
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
          <ChevronUpDownIcon className="h-4 w-4 text-muted" aria-hidden="true" />
        </span>
      </SharedListboxButton>
      <Transition as={Fragment} leave="transition ease-standard duration-fast" leaveFrom="opacity-100" leaveTo="opacity-0">
        <SharedListboxOptions anchor="bottom start" className="max-h-72">
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={labelled ? group.label : undefined}>
              {labelled ? (
                <div aria-hidden="true" className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint first:pt-1">
                  {group.label}
                </div>
              ) : null}
              {group.options.map((option) => (
                <SharedListboxOption key={option.id} value={option} inset="none">
                  {({ selected }) => (
                    <span className="flex min-w-0 items-center gap-2">
                      <ProviderLogo providerType={option.providerType} size="sm" />
                      <span className={`min-w-0 flex-1 truncate ${selected ? 'font-medium' : 'font-normal'}`}>{option.name}</span>
                      {selected ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                    </span>
                  )}
                </SharedListboxOption>
              ))}
            </div>
          ))}
        </SharedListboxOptions>
      </Transition>
    </Listbox>
  );
}
