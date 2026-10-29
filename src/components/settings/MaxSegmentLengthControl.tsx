'use client';

import { useState } from 'react';
import { RangeInput, Select, SettingRow } from '@/components/ui';
import { AdvancedSettingsGroup } from './AdvancedSettings';
import { RefreshIcon, TextCursorIcon } from '@/components/icons/Icons';
import { TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN, TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX, TTS_SEGMENT_MAX_BLOCK_LENGTH_STEP } from '@/types/config';

const presets = [150, 300, 450, 600, 900, 1200];

export function MaxSegmentLengthControl({ value, onChange, overridden = false, onReset }: {
  value: number; onChange: (value: number) => void; overridden?: boolean; onReset?: () => void;
}) {
  const [editingCustom, setEditingCustom] = useState(false);
  const options: Array<{ value: number | 'custom'; label: string }> = [
    ...presets.map(value => ({ value, label: `${value} characters` })),
    { value: 'custom', label: presets.includes(value) ? 'Custom…' : `${value} characters` },
  ];
  return <AdvancedSettingsGroup title="Narration segments">
    <SettingRow label="Max segment length" icon={<TextCursorIcon />} controlClassName="w-40 max-w-[48%]"
      info="The longest passage narrated as one segment. Changing it rebuilds the narration plan."
      labelAction={overridden && onReset ? <button type="button" aria-label="Use app default for max segment length" title="Use app default"
        onClick={onReset} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <RefreshIcon className="h-3 w-3" aria-hidden />
      </button> : null}>
      <div className="space-y-2">
        <Select aria-label="Max segment length" value={options.find(option => option.value === value) ?? options.at(-1)} options={options}
          buttonClassName="!pl-2 !pr-6" chevronClassName="h-4 w-4 text-soft"
          onChange={option => { setEditingCustom(option.value === 'custom'); if (option.value !== 'custom') onChange(option.value); }} />
        {(editingCustom || !presets.includes(value)) && <RangeInput aria-label="Adjust max segment length"
          min={TTS_SEGMENT_MAX_BLOCK_LENGTH_MIN} max={TTS_SEGMENT_MAX_BLOCK_LENGTH_MAX} step={TTS_SEGMENT_MAX_BLOCK_LENGTH_STEP}
          value={value} onChange={event => onChange(Number(event.target.value))} />}
      </div>
    </SettingRow>
  </AdvancedSettingsGroup>;
}
