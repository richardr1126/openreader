'use client';

import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from '@headlessui/react';
import { ChevronUpDownIcon, AudioWaveIcon, CheckIcon } from '@/components/icons/Icons';
import { useEffect, useMemo, useState } from 'react';
import { buildKokoroVoiceString, getMaxVoicesForProvider, isKokoroModel, parseKokoroVoiceNames } from '@/lib/shared/kokoro';

export function VoicesControlBase({
  availableVoices,
  voice,
  onChangeVoice,
  ttsProvider,
  ttsModel,
  dropdownDirection = 'up',
  variant = 'compact',
}: {
  availableVoices: string[];
  voice: string;
  onChangeVoice: (voice: string) => void;
  ttsProvider: string;
  ttsModel: string;
  dropdownDirection?: 'up' | 'down';
  variant?: 'compact' | 'field';
}) {
  const dropdownPosition = dropdownDirection === 'down'
    ? 'top-full left-0 mt-1'
    : 'bottom-full right-0 mb-1';

  const buttonClass = variant === 'field'
    ? 'relative cursor-pointer rounded-lg bg-base py-1.5 pl-3 pr-10 text-left text-foreground focus:outline-none focus:ring-2 focus:ring-accent transform transition-transform duration-200 ease-in-out hover:scale-[1.01] hover:text-accent w-full'
    : 'flex items-center space-x-0.5 sm:space-x-1 bg-transparent text-foreground text-xs sm:text-sm focus:outline-none cursor-pointer hover:bg-offbase rounded pl-1.5 sm:pl-2 pr-0.5 sm:pr-1 py-0.5 sm:py-1 transform transition-transform duration-200 ease-in-out hover:scale-[1.04] hover:text-accent';

  const iconClass = variant === 'field'
    ? 'h-3.5 w-3.5 shrink-0'
    : 'h-3 w-3 sm:h-3.5 sm:w-3.5';

  const chevronClass = variant === 'field'
    ? 'h-4 w-4 text-muted'
    : 'h-2.5 w-2.5 sm:h-3 sm:w-3';

  const dropdownWidth = variant === 'field'
    ? 'w-full'
    : isKokoroModel(ttsModel) && getMaxVoicesForProvider(ttsProvider, ttsModel) > 1 ? 'w-40 sm:w-44' : 'w-28 sm:w-32';
  const isKokoro = isKokoroModel(ttsModel);
  const maxVoices = getMaxVoicesForProvider(ttsProvider, ttsModel);

  const [selectedVoices, setSelectedVoices] = useState<string[]>([]);

  useEffect(() => {
    if (!(isKokoro && maxVoices > 1)) return;
    let initial: string[] = [];
    if (voice && voice.includes('+')) {
      initial = parseKokoroVoiceNames(voice);
    } else if (voice && availableVoices.includes(voice)) {
      initial = [voice];
    } else if (availableVoices.length > 0) {
      initial = [availableVoices[0]];
    }
    if (initial.length > maxVoices) {
      initial = initial.slice(0, maxVoices);
    }
    setSelectedVoices(initial);
  }, [isKokoro, maxVoices, voice, availableVoices]);

  const currentVoice = useMemo(() => {
    if (isKokoro && maxVoices > 1) {
      const combined = buildKokoroVoiceString(selectedVoices);
      return combined || (availableVoices[0] || '');
    }
    return voice && availableVoices.includes(voice) ? voice : availableVoices[0] || '';
  }, [isKokoro, maxVoices, selectedVoices, availableVoices, voice]);

  if (availableVoices.length === 0) {
    return (
      <div className="relative">
        <div className="flex items-center space-x-0.5 sm:space-x-1 bg-transparent text-muted text-xs sm:text-sm rounded pl-1.5 sm:pl-2 pr-0.5 sm:pr-1 py-0.5 sm:py-1">
          <AudioWaveIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
          <span>No voices</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {isKokoro && maxVoices > 1 ? (
        <Listbox
          multiple
          value={selectedVoices}
          onChange={(vals: string[]) => {
            if (!vals || vals.length === 0) return;

            let next = vals;
            if (vals.length > maxVoices) {
              const newlyAdded = vals.find((v) => !selectedVoices.includes(v));
              if (newlyAdded) {
                const lastPrev = selectedVoices[selectedVoices.length - 1] ?? selectedVoices[0] ?? '';
                const pair = Array.from(new Set([lastPrev, newlyAdded])).filter(Boolean);
                next = pair.slice(0, maxVoices);
              } else {
                next = vals.slice(-maxVoices);
              }
            }

            setSelectedVoices(next);
            const combined = buildKokoroVoiceString(next);
            if (combined) {
              onChangeVoice(combined);
            }
          }}
        >
          <ListboxButton className={buttonClass}>
            {variant === 'field' ? (
              <>
                <span className="flex items-center gap-2 truncate text-sm font-medium">
                  <AudioWaveIcon className={iconClass} />
                  {selectedVoices.length > 1 ? selectedVoices.join(' + ') : selectedVoices[0] || currentVoice}
                </span>
                <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                  <ChevronUpDownIcon className={chevronClass} />
                </span>
              </>
            ) : (
              <>
                <AudioWaveIcon className={iconClass} />
                <span>{selectedVoices.length > 1 ? selectedVoices.join(' + ') : selectedVoices[0] || currentVoice}</span>
                <ChevronUpDownIcon className={chevronClass} />
              </>
            )}
          </ListboxButton>
          <ListboxOptions className={`absolute ${dropdownPosition} z-50 ${dropdownWidth} !h-auto !min-h-0 !max-h-[50vh] overflow-y-auto overscroll-contain rounded-lg bg-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none`}>
            {availableVoices.map((voiceId) => (
              <ListboxOption
                key={voiceId}
                value={voiceId}
                className={({ active, selected }) =>
                  `relative cursor-pointer select-none py-1 px-2 sm:py-2 sm:px-3 flex items-center gap-2 ${active ? 'bg-offbase' : ''} ${selected ? 'font-medium bg-accent text-background' : ''} ${selected && active ? 'text-foreground' : ''}`
                }
              >
                {({ selected }) => (
                  <>
                    {selected ? (
                      <CheckIcon className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <span className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="text-xs sm:text-sm">{voiceId}</span>
                  </>
                )}
              </ListboxOption>
            ))}
          </ListboxOptions>
        </Listbox>
      ) : (
        <Listbox value={currentVoice} onChange={onChangeVoice}>
          <ListboxButton className={buttonClass}>
            {variant === 'field' ? (
              <>
                <span className="flex items-center gap-2 truncate text-sm font-medium">
                  <AudioWaveIcon className={iconClass} />
                  {currentVoice}
                </span>
                <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                  <ChevronUpDownIcon className={chevronClass} />
                </span>
              </>
            ) : (
              <>
                <AudioWaveIcon className={iconClass} />
                <span>{currentVoice}</span>
                <ChevronUpDownIcon className={chevronClass} />
              </>
            )}
          </ListboxButton>
          <ListboxOptions className={`absolute ${dropdownPosition} z-50 ${dropdownWidth} !h-auto !min-h-0 !max-h-[50vh] overflow-y-auto overscroll-contain rounded-lg bg-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none`}>
            {availableVoices.map((voiceId) => (
              <ListboxOption
                key={voiceId}
                value={voiceId}
                className={({ active, selected }) =>
                  `relative cursor-pointer select-none py-1 px-2 sm:py-2 sm:px-3 ${active ? 'bg-offbase' : ''} ${selected ? 'font-medium bg-accent text-background' : ''} ${selected && active ? 'text-foreground' : ''}`
                }
              >
                <span className="text-xs sm:text-sm">{voiceId}</span>
              </ListboxOption>
            ))}
          </ListboxOptions>
        </Listbox>
      )}
    </div>
  );
}
