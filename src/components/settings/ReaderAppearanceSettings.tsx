'use client';

import { useEffect, useState } from 'react';
import { Button, RangeField, Section, Select, SettingRow } from '@/components/ui';
import { ColorPicker } from '@/components/ColorPicker';
import { TextCursorIcon } from '@/components/icons/Icons';
import { useConfig } from '@/contexts/ConfigContext';
import { useReaderAppearance } from '@/contexts/ReaderAppearanceContext';
import {
  DEFAULT_TYPOGRAPHY, DEFAULT_HIGHLIGHT_APPEARANCE, HIGHLIGHT_PRESETS, TYPOGRAPHY_RANGES,
  normalizeTypography, normalizeHighlightAppearance, type ReaderTypography, type HighlightAppearance,
} from '@/lib/shared/reader-appearance';

type Values = ReaderTypography & HighlightAppearance;
const labels: Record<keyof typeof TYPOGRAPHY_RANGES, string> = {
  sizePercent: 'Text size', lineMultiplier: 'Line spacing', paragraphSpacing: 'Paragraph spacing',
  letterSpacing: 'Letter spacing', readingWidth: 'Reading width',
};
const TYPE_OPTIONS = {
  fontFamily: ['default', 'serif', 'sans', 'rounded', 'mono'],
  alignment: ['default', 'left', 'justify'],
};
const SELECT_OPTIONS = Object.fromEntries(Object.entries(TYPE_OPTIONS).map(([key, values]) => [key,
  values.map((value) => ({ value, label: value === 'default' ? 'Default / publisher' : value === 'justify' ? 'Justified' : value.charAt(0).toUpperCase() + value.slice(1) })),
])) as Record<keyof typeof TYPE_OPTIONS, { value: string; label: string }[]>;

export function ReaderAppearanceSettings({ scope = 'global', showTypography = true }: {
  scope?: 'global' | 'book'; showTypography?: boolean;
}) {
  const config = useConfig();
  const { book } = useReaderAppearance();
  const ownTypography = scope === 'book' ? book?.settings.typography ?? {} : config.readerTypography;
  const ownHighlights = scope === 'book' ? book?.settings.highlightAppearance ?? {} : config.highlightAppearance;
  const resolved = {
    ...normalizeTypography({ ...config.readerTypography, ...ownTypography }),
    ...normalizeHighlightAppearance({ ...config.highlightAppearance, ...ownHighlights }),
  };
  const signature = JSON.stringify(resolved);
  const [draft, setDraft] = useState<Values>(resolved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(JSON.parse(signature) as Values); }, [signature]);

  async function save(kind: 'typography' | 'highlightAppearance', patch: Partial<Values>, reset = false) {
    setBusy(true); setError(null);
    try {
      const own = kind === 'typography' ? ownTypography : ownHighlights;
      const next = reset ? {} : { ...own, ...patch };
      if (scope === 'book') {
        if (!book) throw new Error('Book settings are not ready.');
        await book.update({ [kind]: next });
      }
      else if (kind === 'typography') await config.updateConfigKey('readerTypography', normalizeTypography(next));
      else await config.updateConfigKey('highlightAppearance', normalizeHighlightAppearance(next));
    } catch (e) {
      setDraft(resolved);
      setError(e instanceof Error ? e.message : 'Could not save reader appearance.');
    } finally { setBusy(false); }
  }
  function inherit(kind: 'typography' | 'highlightAppearance', key: keyof Values) {
    const own = kind === 'typography' ? ownTypography : ownHighlights;
    const next = { ...own }; delete (next as Partial<Values>)[key];
    // Replace the override, rather than merging back the field being removed.
    setBusy(true); setError(null);
    void book?.update({ [kind]: next }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  }
  const resetField = (kind: 'typography' | 'highlightAppearance', key: keyof Values) => scope === 'book'
    && Object.hasOwn(kind === 'typography' ? ownTypography : ownHighlights, key)
    ? <Button size="sm" variant="ghost" onClick={() => inherit(kind, key)} aria-label={`Use global ${key}`}>Use global</Button> : null;

  return <fieldset disabled={busy || (scope === 'book' && !book)} className="min-w-0 space-y-5">
    <p className="text-xs text-soft">{scope === 'book' ? 'This book inherits your global settings until you change a control.' : 'Defaults for all books. Individual books can override these settings.'}</p>
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    {showTypography && <Section title="Typography" variant="group">
      {(['fontFamily', 'alignment'] as const).map((key) => <div key={key} className="space-y-1">
        <SettingRow label={key === 'fontFamily' ? 'Font family' : 'Alignment'} icon={<TextCursorIcon />}>
          <Select aria-label={key === 'fontFamily' ? 'Font family' : 'Alignment'} disabled={busy}
            value={SELECT_OPTIONS[key].find((option) => option.value === draft[key])}
            options={SELECT_OPTIONS[key]}
            onChange={({ value }) => { setDraft({ ...draft, [key]: value }); void save('typography', { [key]: value }); }} />
        </SettingRow>{resetField('typography', key)}
      </div>)}
      {(Object.keys(TYPOGRAPHY_RANGES) as (keyof typeof TYPOGRAPHY_RANGES)[]).map((key) => {
        const [min, max, step] = TYPOGRAPHY_RANGES[key];
        return <div key={key}><RangeField label={labels[key]} min={min} max={max} step={step} value={draft[key]}
          formatter={(v) => key === 'sizePercent' || key === 'readingWidth' ? `${v}%` : String(Number(v.toFixed(2)))}
          onChange={(value) => setDraft({ ...draft, [key]: value })}
          onPointerUp={() => void save('typography', { [key]: draft[key] })}
          onKeyUp={() => void save('typography', { [key]: draft[key] })} />{resetField('typography', key)}</div>;
      })}
      <Button size="sm" variant="ghost" onClick={() => void save('typography', DEFAULT_TYPOGRAPHY, scope === 'book')}>{scope === 'book' ? 'Use global typography' : 'Reset typography'}</Button>
    </Section>}
    <Section title="Highlight appearance" variant="group">
      <div className="flex flex-wrap gap-2" aria-label="Highlight presets">
        {Object.entries(HIGHLIGHT_PRESETS).map(([name, preset]) => <Button key={name} size="sm" variant="secondary" onClick={() => void save('highlightAppearance', preset)}>{name}</Button>)}
      </div>
      {(['segment', 'word'] as const).map((layer) => {
        const colorKey = `${layer}Color` as const, opacityKey = `${layer}Opacity` as const;
        const title = layer === 'segment' ? 'Segment' : 'Word';
        return <div key={layer} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{title} color</span>
            <ColorPicker label={title} field="accent" value={draft[colorKey] === 'theme' ? '#ef4444' : draft[colorKey]}
              onChange={(color) => { setDraft({ ...draft, [colorKey]: color }); void save('highlightAppearance', { [colorKey]: color }); }} />
            <Button size="sm" variant="ghost" onClick={() => void save('highlightAppearance', { [colorKey]: 'theme' })}>Theme color</Button>
          </div>
          {resetField('highlightAppearance', colorKey)}
          <RangeField label={`${title} opacity`} min={0} max={1} step={0.01} value={draft[opacityKey]} formatter={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => setDraft({ ...draft, [opacityKey]: v })} onPointerUp={() => void save('highlightAppearance', { [opacityKey]: draft[opacityKey] })} onKeyUp={() => void save('highlightAppearance', { [opacityKey]: draft[opacityKey] })} />
          {resetField('highlightAppearance', opacityKey)}
        </div>;
      })}
      <p aria-label="Highlight preview" className="rounded p-3 text-sm" style={{ backgroundColor: `color-mix(in srgb, ${draft.segmentColor === 'theme' ? 'var(--accent)' : draft.segmentColor} ${draft.segmentOpacity * 100}%, transparent)` }}>Read at your own pace, <span style={{ backgroundColor: `color-mix(in srgb, ${draft.wordColor === 'theme' ? 'var(--accent)' : draft.wordColor} ${draft.wordOpacity * 100}%, transparent)` }}>word</span> by word.</p>
      <Button size="sm" variant="ghost" onClick={() => void save('highlightAppearance', DEFAULT_HIGHLIGHT_APPEARANCE, scope === 'book')}>{scope === 'book' ? 'Use global highlights' : 'Reset highlight appearance'}</Button>
    </Section>
  </fieldset>;
}
