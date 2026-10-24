'use client';

import { useState } from 'react';
import { RangeInput, Select, SettingRow } from '@/components/ui';
import { AdvancedSettingsGroup } from './AdvancedSettings';
import { RefreshIcon, TextCursorIcon, PauseIcon } from '@/components/icons/Icons';
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
      ? <button type="button" aria-label={`Use app default for ${label.toLowerCase()}`} title="Use app default"
        onClick={() => onReset(key)} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <RefreshIcon className="h-3 w-3" aria-hidden />
      </button> : null;
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
      {control('pieceCharacterLimit', 'Piece length', 'Automatic preserves the model’s existing split policy. A custom character target prefers sentence and word boundaries within each narration segment. Model limits still apply; your reading position stays the same.')}
    </AdvancedSettingsGroup>}
    <AdvancedSettingsGroup title="Added pauses">
      {local && control('piecePauseMilliseconds', 'Between pieces', 'Silence between successful model-generated pieces, including joins inside a sentence. Automatic keeps the current 0 ms of added silence. A custom piece length can create more joins. Natural pauses produced by the voice remain.')}
      {control('blockPauseMilliseconds', 'Between segments', 'Silence after each narration segment, including audiobook exports. Segments are reader blocks, not necessarily sentences or paragraphs. Automatic keeps the current 0 ms of added silence. Zero preserves the voice’s natural pauses. Player speed also changes the length of added pauses.')}
    </AdvancedSettingsGroup>
  </>;
}
