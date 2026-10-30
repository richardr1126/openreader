'use client';

import { ResetButton, Select, SettingRow, Switch } from '@/components/ui';
import { BookmarksListIcon, TextCursorIcon } from '@/components/icons/Icons';
import { BRACKETED_TEXT_MODES, type SpeechTextOptions } from '@openreader/tts/speech-text';

const labels = { off: 'Off', square: 'Square brackets', parentheses: 'Parentheses', both: 'Both' };
const options = BRACKETED_TEXT_MODES.map(value => ({ value, label: labels[value] }));

export function SpeechTextControls({ value, onChange, overrides, onReset }: {
  value: SpeechTextOptions;
  onChange: (change: Partial<SpeechTextOptions>) => void;
  overrides?: Partial<SpeechTextOptions>;
  onReset?: (key: keyof SpeechTextOptions) => void;
}) {
  const reset = (key: keyof SpeechTextOptions) => overrides?.[key] !== undefined && onReset
    ? <ResetButton label={`Use app default for ${key === 'citations' ? 'citations' : 'bracketed text'}`} onClick={() => onReset(key)} />
    : null;
  return <>
    <SettingRow label="Citations" icon={<BookmarksListIcon />}
      info="Skip numeric references such as [1, 3–5] and author–year citations such as (Smith, 2024). Only speech changes; the displayed document stays intact."
      labelAction={reset('citations')} controlClassName="w-auto">
      <Switch ariaLabel="Skip citations" checked={value.citations} onChange={citations => onChange({ citations })} />
    </SettingRow>
    <SettingRow label="Bracketed text" icon={<TextCursorIcon />}
      info="Skip all text inside square brackets, parentheses, or both. Off preserves bracketed prose. Only speech changes; the displayed document stays intact."
      labelAction={reset('brackets')} controlClassName="w-40 max-w-[48%]">
      <Select aria-label="Skip bracketed text" value={options.find(option => option.value === value.brackets)} options={options} onChange={({ value: brackets }) => onChange({ brackets })} />
    </SettingRow>
  </>;
}
