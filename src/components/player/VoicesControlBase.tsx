'use client';

import {
  Listbox,
} from '@headlessui/react';
import { ChevronUpDownIcon, AudioWaveIcon, CheckIcon } from '@/components/icons/Icons';
import { useEffect, useMemo, useState } from 'react';
import { buildKokoroVoiceString, parseKokoroVoiceNames } from '@/lib/shared/kokoro';
import { type TtsProviderType } from '@/lib/shared/tts-provider-catalog';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { SharedListboxButton, SharedListboxOption, SharedListboxOptions, cn } from '@/components/ui';

export function VoicesControlBase({
  availableVoices,
  voice,
  onChangeVoice,
  providerType,
  ttsModel,
  dropdownDirection = 'up',
  variant = 'compact',
}: {
  availableVoices: string[];
  voice: string;
  onChangeVoice: (voice: string) => void;
  providerType: TtsProviderType;
  ttsModel: string;
  dropdownDirection?: 'up' | 'down';
  variant?: 'compact' | 'field';
}) {
  const dropdownPosition = dropdownDirection === 'down'
    ? 'top-full left-0 mt-1'
    : 'bottom-full right-0 mb-1';

  const buttonClass = variant === 'field'
    ? 'bg-surface pr-10'
    : 'space-x-0.5 px-1.5 py-0.5 text-xs sm:space-x-1 sm:px-2 sm:py-1 sm:text-sm';
  const buttonTone = variant === 'field' ? 'default' : 'popover';

  const iconClass = variant === 'field'
    ? 'h-3.5 w-3.5 shrink-0'
    : 'h-3 w-3 sm:h-3.5 sm:w-3.5';

  const chevronClass = variant === 'field'
    ? 'h-4 w-4 text-soft'
    : 'h-2.5 w-2.5 sm:h-3 sm:w-3';

  const providerModelPolicy = resolveTtsProviderModelPolicy({
    providerRef: '',
    providerType,
    model: ttsModel,
  });
  const dropdownWidth = variant === 'field'
    ? 'w-full'
    : providerModelPolicy.isKokoroModel && providerModelPolicy.maxVoices > 1 ? 'w-40 sm:w-44' : 'w-28 sm:w-32';
  const isKokoro = providerModelPolicy.isKokoroModel;
  const maxVoices = providerModelPolicy.maxVoices;

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
        <div className="flex items-center space-x-0.5 sm:space-x-1 bg-transparent text-soft text-xs sm:text-sm rounded pl-1.5 sm:pl-2 pr-0.5 sm:pr-1 py-0.5 sm:py-1">
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
          <SharedListboxButton tone={buttonTone} className={buttonClass}>
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
          </SharedListboxButton>
          <SharedListboxOptions tone="default" className={cn('absolute !h-auto !min-h-0 !max-h-[50vh]', dropdownPosition, dropdownWidth)}>
            {availableVoices.map((voiceId) => (
              <SharedListboxOption
                key={voiceId}
                value={voiceId}
                inset="none"
                itemClassName="flex items-center gap-2 py-1 sm:py-2"
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
              </SharedListboxOption>
            ))}
          </SharedListboxOptions>
        </Listbox>
      ) : (
        <Listbox value={currentVoice} onChange={onChangeVoice}>
          <SharedListboxButton tone={buttonTone} className={buttonClass}>
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
          </SharedListboxButton>
          <SharedListboxOptions tone="default" className={cn('absolute !h-auto !min-h-0 !max-h-[50vh]', dropdownPosition, dropdownWidth)}>
            {availableVoices.map((voiceId) => (
              <SharedListboxOption
                key={voiceId}
                value={voiceId}
                inset="none"
                itemClassName="py-1 sm:py-2"
              >
                <span className="text-xs sm:text-sm">{voiceId}</span>
              </SharedListboxOption>
            ))}
          </SharedListboxOptions>
        </Listbox>
      )}
    </div>
  );
}
