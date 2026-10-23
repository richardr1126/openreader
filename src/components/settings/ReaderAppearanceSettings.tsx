'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button, Section, Select, SettingRow, SegmentedControl } from '@/components/ui';
import { ColorPicker } from '@/components/ColorPicker';
import { PaletteIcon, RefreshIcon, TextCursorIcon } from '@/components/icons/Icons';
import { useConfig } from '@/contexts/ConfigContext';
import { useReaderAppearance } from '@/contexts/ReaderAppearanceContext';
import {
  DEFAULT_TYPOGRAPHY, DEFAULT_HIGHLIGHT_APPEARANCE, HIGHLIGHT_PRESETS, TYPOGRAPHY_RANGES,
  normalizeTypography, normalizeHighlightAppearance, type ReaderTypography, type HighlightAppearance,
  READER_FONT_FAMILIES, highlightBackground,
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
const SPACING_PRESETS = [
  { label: 'Compact', lineMultiplier: 1.2, paragraphSpacing: 0.75, letterSpacing: 0 },
  { label: 'Balanced', lineMultiplier: 1.5, paragraphSpacing: 1, letterSpacing: 0 },
  { label: 'Open', lineMultiplier: 1.9, paragraphSpacing: 1.5, letterSpacing: 0.03 },
] as const;
const WIDTH_PRESETS = [{ label: 'Compact', value: 60 }, { label: 'Balanced', value: 80 }, { label: 'Full', value: 100 }] as const;
const PREVIEW_PARAGRAPHS = [
  'The afternoon light fell across the page. There was time to pause, and room for the story to unfold.',
  'Outside, the street had gone quiet. A kettle ticked as it cooled, and somewhere a door closed softly, the way doors do when no one wants to be the reason for a sound.',
  'She turned the page and kept going. The chapter was longer than she remembered, but the words came easily now, one sentence leaning into the next.',
  'By the time she looked up, the window had turned from gold to blue. The tea beside her had gone cold hours ago, a thin ring left on the saucer where she had set it down without thinking. Somewhere below, a neighbor was practicing scales on an old piano, missing the same note each time and starting over with a patience she almost envied.',
  'She marked the page with the corner of an envelope and stood to stretch. The room smelled of paper and rain. On the shelf, the rest of the series waited in a neat row, their spines faded unevenly from years of the same afternoon sun, and she let her hand rest on the next one for a moment before deciding it could wait until morning.',
  'It could not wait until morning. She carried it back to the chair, folded her legs beneath her, and opened to the first page, where a map of an invented coastline was drawn in faint brown ink, every harbor named, every lighthouse marked with a small careful star.',
];
const SELECT_OPTIONS =Object.fromEntries(Object.entries(TYPE_OPTIONS).map(([key, values]) => [key,
  values.map((value) => ({ value, label: value === 'default' ? 'Default / publisher' : value === 'justify' ? 'Justified' : value.charAt(0).toUpperCase() + value.slice(1) })),
])) as Record<keyof typeof TYPE_OPTIONS, { value: string; label: string }[]>;

function ResetIcon({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick}
    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
    <RefreshIcon className="h-3 w-3" aria-hidden />
  </button>;
}

function CompactNumber({ label, value, min, max, step, suffix = '', onChange }: {
  label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: number) => {
    if (!Number.isFinite(raw)) { setText(String(value)); return; }
    const next = Number(Math.min(max, Math.max(min, Math.round(raw / step) * step)).toFixed(2));
    setText(String(next));
    if (next !== value) onChange(next);
  };
  return <div className="inline-flex h-8 shrink-0 items-center gap-0.5" role="group" aria-label={label}>
    <Button size="sm" variant="ghost" className="w-8 px-0 text-soft" aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => commit(value - step)}>{label === 'Text size' ? 'A−' : '−'}</Button>
    <div className="flex items-center text-xs tabular-nums text-foreground">
      <input type="number" aria-label={label} min={min} max={max} step={step} value={text}
        className="h-7 w-11 rounded border-0 bg-transparent p-0 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        onChange={(event) => setText(event.target.value)} onBlur={() => commit(text.trim() ? Number(text) : NaN)}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        onKeyUp={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') commit(Number(event.currentTarget.value)); }} />
      {suffix && <span className="pl-0.5 text-soft">{suffix}</span>}
    </div>
    <Button size="sm" variant="ghost" className="w-8 px-0 text-soft" aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => commit(value + step)}>{label === 'Text size' ? 'A+' : '+'}</Button>
  </div>;
}

/** Three-line glyph shared by the preset segments; each preset varies gap or line widths. */
function LinesGlyph({ gap = 2, widths = [100, 100, 100], centered = false }: { gap?: number; widths?: readonly number[]; centered?: boolean }) {
  return <span aria-hidden className={`flex w-4 shrink-0 flex-col ${centered ? 'items-center' : 'items-start'}`} style={{ gap }}>
    {widths.map((width, line) => <span key={line} className="h-px bg-current" style={{ width: `${width}%` }} />)}
  </span>;
}

const segmentLabel = (glyph: ReactNode, text: string) => <span className="inline-flex items-center justify-center gap-2">{glyph}{text}</span>;

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
    ? <span className="inline-flex h-5 w-5 shrink-0">
      {Object.hasOwn(kind === 'typography' ? ownTypography : ownHighlights, key)
        ? <ResetIcon label={`Use global ${key}`} onClick={() => inherit(kind, key)} /> : null}
    </span> : null;
  const typographyChanged = scope === 'book' ? Object.keys(ownTypography).length > 0 : JSON.stringify(ownTypography) !== JSON.stringify(DEFAULT_TYPOGRAPHY);
  const highlightsChanged = scope === 'book' ? Object.keys(ownHighlights).length > 0 : JSON.stringify(ownHighlights) !== JSON.stringify(DEFAULT_HIGHLIGHT_APPEARANCE);
  const change = (kind: 'typography' | 'highlightAppearance', patch: Partial<Values>) => {
    setDraft({ ...draft, ...patch });
    void save(kind, patch);
  };
  const number = (key: keyof typeof TYPOGRAPHY_RANGES) => {
    const [min, max, step] = TYPOGRAPHY_RANGES[key];
    return <div className="flex items-center justify-between gap-2" key={key}>
      <span className="text-sm font-medium">{labels[key]}</span>
      <div className="flex items-center gap-1.5"><CompactNumber label={labels[key]} value={draft[key]} min={min} max={max} step={step}
        suffix={key === 'sizePercent' || key === 'readingWidth' ? '%' : key === 'lineMultiplier' ? '×' : 'em'}
        onChange={(value) => change('typography', { [key]: value })} />{resetField('typography', key)}</div>
    </div>;
  };

  return <fieldset disabled={busy || (scope === 'book' && !book)} className="min-w-0 space-y-5">
    <p className="text-xs text-soft">{scope === 'book' ? 'This book inherits your global settings until you change a control.' : 'Defaults for all books. Individual books can override these settings.'}</p>
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    {showTypography && <Section title="Typography" variant="group" action={typographyChanged &&
      <ResetIcon label={scope === 'book' ? 'Use global typography' : 'Reset typography'} onClick={() => void save('typography', DEFAULT_TYPOGRAPHY, scope === 'book')} />}>
      <div aria-label="Typography preview" role="region" className="overflow-hidden text-foreground">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-faint"><span>Reading preview</span><span>Live</span></div>
        {/* Taller on wide screens so a real page of text shows; the fade marks the clip as intentional. */}
        <div role="article" aria-label="Reading sample" className="mx-auto h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)] sm:h-60 lg:h-80" style={{ width: `${draft.readingWidth}%`, fontFamily: READER_FONT_FAMILIES[draft.fontFamily] || 'Georgia, serif',
          fontSize: `${14 * draft.sizePercent / 100}px`, lineHeight: draft.lineMultiplier, letterSpacing: `${draft.letterSpacing}em`, textAlign: draft.alignment === 'default' ? 'start' : draft.alignment }}>
          {PREVIEW_PARAGRAPHS.map((text) => <p key={text} style={{ marginBottom: `${draft.paragraphSpacing}em` }}>{text}</p>)}
        </div>
      </div>
      <div>
        <SettingRow label="Font family" icon={<TextCursorIcon />}>
          <div className="flex items-center gap-1.5"><div className="min-w-0 flex-1"><Select aria-label="Font family" disabled={busy}
            value={SELECT_OPTIONS.fontFamily.find((option) => option.value === draft.fontFamily)} options={SELECT_OPTIONS.fontFamily}
            renderValue={(option) => <span style={{ fontFamily: READER_FONT_FAMILIES[option.value as ReaderTypography['fontFamily']] || undefined }}>{option.label}</span>}
            renderOption={(option) => <span className="flex items-center justify-between gap-4" style={{ fontFamily: READER_FONT_FAMILIES[option.value as ReaderTypography['fontFamily']] || undefined }}><span>{option.label}</span><span aria-hidden className="text-[1rem]">Aa</span></span>}
            onChange={({ value }) => change('typography', { fontFamily: value as ReaderTypography['fontFamily'] })} /></div>
            {resetField('typography', 'fontFamily')}</div>
        </SettingRow>
      </div>
      {number('sizePercent')}
      <div className="space-y-2">
        <span className="text-sm font-medium">Spacing</span>
        <SegmentedControl ariaLabel="Spacing presets" className="grid-cols-3"
          value={SPACING_PRESETS.find((preset) => draft.lineMultiplier === preset.lineMultiplier && draft.paragraphSpacing === preset.paragraphSpacing && draft.letterSpacing === preset.letterSpacing)?.label ?? ''}
          onChange={(label) => { const { lineMultiplier, paragraphSpacing, letterSpacing } = SPACING_PRESETS.find((option) => option.label === label)!; change('typography', { lineMultiplier, paragraphSpacing, letterSpacing }); }}
          options={SPACING_PRESETS.map(({ label }, index) => ({ value: label, label: segmentLabel(<LinesGlyph gap={index + 1} />, label) }))} />
      </div>
      {number('lineMultiplier')}
      {number('paragraphSpacing')}
      {number('letterSpacing')}
      <div className="space-y-2">
        {number('readingWidth')}
        <SegmentedControl ariaLabel="Reading width presets" className="grid-cols-3"
          value={String(draft.readingWidth)} onChange={(value) => change('typography', { readingWidth: Number(value) })}
          options={WIDTH_PRESETS.map(({ label, value }) => ({ value: String(value), label: segmentLabel(<LinesGlyph centered widths={[value, value, value * 0.7]} />, label) }))} />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between"><span className="text-sm font-medium">Alignment</span>{resetField('typography', 'alignment')}</div>
        <SegmentedControl ariaLabel="Alignment" value={draft.alignment} className="grid-cols-3" onChange={(value) => change('typography', { alignment: value })}
          options={SELECT_OPTIONS.alignment.map((option) => ({ value: option.value as ReaderTypography['alignment'],
            label: segmentLabel(<LinesGlyph widths={option.value === 'justify' ? [100, 100, 100] : [100, 60, 100]} />, option.value === 'default' ? 'Default' : option.label) }))} />
      </div>
    </Section>}
    <Section title="Highlight appearance" variant="group" action={highlightsChanged &&
      <ResetIcon label={scope === 'book' ? 'Use global highlights' : 'Reset highlight appearance'} onClick={() => void save('highlightAppearance', DEFAULT_HIGHLIGHT_APPEARANCE, scope === 'book')} />}>
      <p aria-label="Highlight preview" className="rounded p-3 text-sm" style={{ backgroundColor: highlightBackground(draft, 'segment') }}>Read at your own pace, <span style={{ backgroundColor: highlightBackground(draft, 'word') }}>word</span> by word.</p>
      <div className="grid grid-cols-4 gap-2" aria-label="Highlight presets">
        {Object.entries(HIGHLIGHT_PRESETS).map(([name, preset]) => {
          const selected = Object.entries(preset).every(([key, value]) => draft[key as keyof HighlightAppearance] === value);
          return <button type="button" key={name} aria-pressed={selected}
            className={`flex min-w-0 flex-col items-center gap-1.5 rounded-lg border py-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selected ? 'border-accent bg-accent-wash' : 'border-transparent hover:bg-accent-wash'}`}
            onClick={() => change('highlightAppearance', preset)}><span aria-hidden className="rounded px-3 py-1 text-sm" style={{ backgroundColor: highlightBackground(preset, 'word') }}>Aa</span>{name}</button>;
        })}
      </div>
      {(['segment', 'word'] as const).map((layer) => {
        const colorKey = `${layer}Color` as const, opacityKey = `${layer}Opacity` as const;
        const title = layer === 'segment' ? 'Segment' : 'Word';
        return <div key={layer} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex-1 text-sm font-medium">{title}</span>
            <ColorPicker label={title} field="accent" value={draft[colorKey] === 'theme' ? '#ef4444' : draft[colorKey]}
              onChange={(color) => { setDraft({ ...draft, [colorKey]: color }); void save('highlightAppearance', { [colorKey]: color }); }} />
            <span className="inline-flex h-5 w-5 shrink-0">{draft[colorKey] !== 'theme' && <button type="button" aria-label={`Use theme ${layer} color`} title="Use theme color"
              className="inline-flex h-5 w-5 items-center justify-center rounded text-faint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => void save('highlightAppearance', { [colorKey]: 'theme' })}><PaletteIcon className="h-3 w-3" aria-hidden /></button>}</span>
            {resetField('highlightAppearance', colorKey)}
          </div>
          <div className="flex items-center justify-between gap-2"><span className="text-xs text-soft">Opacity</span><div className="flex items-center gap-1.5">
            <CompactNumber label={`${title} opacity`} value={Math.round(draft[opacityKey] * 100)} min={0} max={100} step={1} suffix="%" onChange={(value) => change('highlightAppearance', { [opacityKey]: value / 100 })} />
            {resetField('highlightAppearance', opacityKey)}</div></div>
        </div>;
      })}
    </Section>
  </fieldset>;
}
