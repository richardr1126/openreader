'use client';

import { useState } from 'react';
import { RangeInput, ResetButton, Select, SettingRow } from '@/components/ui';
import { AdvancedSettingsGroup } from './AdvancedSettings';
import { TextCursorIcon, PauseIcon } from '@/components/icons/Icons';
import type { VoiceCustomization } from '@openreader/tts/voice-customization';

export function VoiceCustomizationControls({ value, local, onChange, overrides, onReset }: {
  value: VoiceCustomization;
  local: boolean;
  onChange: (change: Partial<VoiceCustomization>) => void;
  overrides?: Partial<VoiceCustomization>;
  onReset?: (key: keyof VoiceCustomization) => void;
}) {
  const [customField, setCustomField] = useState<keyof VoiceCustomization | null>(null);
  const control = (key: keyof VoiceCustomization, label: string, info: string) => {
    const length = key === 'pieceCharacterLimit';
    const unit = length ? 'characters' : 'ms';
    const fallback = length ? 450 : 0;
    const current = value[key];
    const presets = length ? [100, 200, 300, 450] : [0, 150, 300, 500, 1000, 2000];
    const options: Array<{ value: number | null | 'custom'; label: string }> = [
      { value: null, label: length ? 'Automatic (model limit)' : 'Automatic (0 ms)' },
      ...presets.map(number => ({ value: number, label: `${number} ${unit}` })),
      { value: 'custom', label: current !== null && !presets.includes(current) ? `${current} ${unit}` : 'Custom…' },
    ];
    const reset = overrides?.[key] !== undefined && onReset
      ? <ResetButton label={`Use app default for ${label.toLowerCase()}`} onClick={() => onReset(key)} /> : null;
    const custom = current !== null && (customField === key || !presets.includes(current));
    return <SettingRow key={key} label={label} icon={length ? <TextCursorIcon /> : <PauseIcon />} info={info} labelAction={reset}
      controlClassName="w-40 max-w-[48%]">
      <div className="space-y-2">
        <Select aria-label={label} value={options.find(option => option.value === current) ?? options.at(-1)} options={options}
          buttonClassName="!pl-2 !pr-6" chevronClassName="h-4 w-4 text-soft"
          renderValue={option => length && option.value === null ? 'Automatic' : option.label}
          renderOption={option => option.label}
          onChange={({ value: next }) => {
            setCustomField(next === 'custom' ? key : null);
            onChange({ [key]: next === 'custom' ? current ?? fallback : next });
          }} />
        {custom && <RangeInput aria-label={`Adjust ${label.toLowerCase()}`} aria-valuetext={`${current} ${unit}`}
          min={length ? 50 : 0} max={length ? 450 : 2000} step={length ? 25 : 50} value={current}
          onChange={event => onChange({ [key]: Number(event.target.value) })} />}
      </div>
    </SettingRow>;
  };
  return <>
    {local && <AdvancedSettingsGroup title="Text grouping">
      {control('pieceCharacterLimit', 'Piece length', 'Splits each segment into pieces of about this many characters, at sentence or word boundaries. Model limits still apply.')}
    </AdvancedSettingsGroup>}
    <AdvancedSettingsGroup title="Added pauses">
      {local && control('piecePauseMilliseconds', 'Between pieces', 'Silence added where pieces join, including inside a sentence. The voice’s own pauses remain.')}
      {control('blockPauseMilliseconds', 'Between segments', 'Silence added after each segment, including in audiobook exports. Player speed scales it too.')}
    </AdvancedSettingsGroup>
  </>;
}
