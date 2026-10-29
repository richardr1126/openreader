'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Section, Select, SegmentedControl, SaveBar, RowIcon, InfoTip } from '@/components/ui';
import { ColorPicker } from '@/components/ColorPicker';
import { BookIcon, DisclosureIcon, DocumentIcon, HighlighterIcon, MinusIcon, PaletteIcon, PlusIcon, RefreshIcon, TextCursorIcon, ZoomIcon } from '@/components/icons/Icons';
import { AnimatedCollapse } from './ExpandableSettingsCard';
import styles from './ReaderAppearanceSettings.module.css';
import { useConfig } from '@/contexts/ConfigContext';
import { useReaderAppearance } from '@/contexts/ReaderAppearanceContext';
import { ReaderPresentationControls } from './ReaderPresentationControls';
import { appHighlightLayers, getHighlightVisibility, resolveReaderPresentation, setAppHighlightLayers, type HighlightVisibility } from '@/lib/shared/reader-presentation';
import type { ReaderPresentation } from '@/lib/shared/reader-presentation';
import {
  DEFAULT_TYPOGRAPHY, DEFAULT_HIGHLIGHT_APPEARANCE, HIGHLIGHT_PRESETS, TYPOGRAPHY_RANGES,
  normalizeTypography, normalizeHighlightAppearance, type ReaderTypography, type HighlightAppearance,
  READER_FONT_FAMILIES, highlightBackground,
} from '@/lib/shared/reader-appearance';

type Values = ReaderTypography & HighlightAppearance;
export type AppearanceDraft = { typography: Partial<ReaderTypography>; highlightAppearance: Partial<HighlightAppearance>; presentation?: Partial<ReaderPresentation>; highlightVisibility?: HighlightVisibility };
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
/** The highlighted segment, split around the word being spoken. */
const PREVIEW_SEGMENT = ['The afternoon light fell across the page. There was ', 'time', ' to pause, and room for the story to unfold.'] as const;
const PREVIEW_PARAGRAPHS = [
  'Outside, the street had gone quiet. A kettle ticked as it cooled, and somewhere a door closed softly, the way doors do when no one wants to be the reason for a sound.',
  'She turned the page and kept going. The chapter was longer than she remembered, but the words came easily now, one sentence leaning into the next.',
  'By the time she looked up, the window had turned from gold to blue. The tea beside her had gone cold hours ago, a thin ring left on the saucer where she had set it down without thinking. Somewhere below, a neighbor was practicing scales on an old piano, missing the same note each time and starting over with a patience she almost envied.',
  'She marked the page with the corner of an envelope and stood to stretch. The room smelled of paper and rain. On the shelf, the rest of the series waited in a neat row, their spines faded unevenly from years of the same afternoon sun, and she let her hand rest on the next one for a moment before deciding it could wait until morning.',
  'It could not wait until morning. She carried it back to the chair, folded her legs beneath her, and opened to the first page, where a map of an invented coastline was drawn in faint brown ink, every harbor named, every lighthouse marked with a small careful star.',
];
const SELECT_OPTIONS = Object.fromEntries(Object.entries(TYPE_OPTIONS).map(([key, values]) => [key,
  values.map((value) => ({ value, label: value === 'default' ? 'Default / publisher' : value === 'justify' ? 'Justified' : value.charAt(0).toUpperCase() + value.slice(1) })),
])) as Record<keyof typeof TYPE_OPTIONS, { value: string; label: string }[]>;

function ResetIcon({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick}
    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
    <RefreshIcon className="h-3 w-3" aria-hidden />
  </button>;
}

const stepButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded-full text-soft hover:bg-accent-wash hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-30';

/** − value + filling the control column, so steppers share both edges. */
function Stepper({ label, value, min, max, step, suffix = '', onChange }: {
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
  return <div role="group" aria-label={label} className="flex h-9 min-w-0 flex-1 items-center justify-between rounded-full border border-line bg-surface-sunken p-1">
    <button type="button" className={stepButtonClass} aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => commit(value - step)}><MinusIcon className="h-3.5 w-3.5" aria-hidden /></button>
    <span className="flex w-[4.25rem] items-center justify-center text-xs tabular-nums text-foreground">
      <input type="number" aria-label={label} min={min} max={max} step={step} value={text}
        className="h-6 w-9 rounded border-0 bg-transparent p-0 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        onChange={(event) => setText(event.target.value)} onBlur={() => commit(text.trim() ? Number(text) : NaN)}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        onKeyUp={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') commit(Number(event.currentTarget.value)); }} />
      <span className="w-5 pl-0.5 text-left text-soft">{suffix}</span>
    </span>
    <button type="button" className={stepButtonClass} aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => commit(value + step)}><PlusIcon className="h-3.5 w-3.5" aria-hidden /></button>
  </div>;
}

/**
 * Label on the left and a fixed-width control column on the right: every control shares the right edge, and
 * each kind shares a left edge. Wide presets stack consistently in narrow panels,
 * based on the settings container rather than the browser viewport.
 */
function Row({ label, wide = false, actions, lead, children }: {
  label: string; wide?: boolean; actions?: ReactNode; lead?: ReactNode; children: ReactNode;
}) {
  const { icon, info } = APPEARANCE_ROWS[label];
  return <div className={`flex items-center justify-between gap-x-4 gap-y-2 ${wide ? styles.wide : ''}`}>
    <div className={`flex min-w-0 items-center gap-3 ${wide ? 'shrink-0' : 'flex-1'}`}>
      <RowIcon>{icon}</RowIcon>
      <span className="flex min-w-0 items-center gap-1 text-sm font-medium text-foreground">
        <span className="min-w-0">{label}</span>{actions}{info ? <InfoTip label={label}>{info}</InfoTip> : null}
      </span>
    </div>
    <div className={`ml-auto flex items-center gap-2 ${wide ? styles.controls : ''}`}>
      {lead}
      <div className={`flex min-w-0 items-center gap-2 ${wide ? styles.column : 'w-40'}`}>{children}</div>
    </div>
  </div>;
}

const segmentedClass = (columns: 3 | 4) => `h-9 flex-1 ${columns === 3 ? 'grid-cols-3' : 'grid-cols-4'} [&>button]:py-0`;

/** Three-line glyph shared by the preset segments; each preset varies gap or line widths. */
function LinesGlyph({ gap = 2, widths = [100, 100, 100], centered = false }: { gap?: number; widths?: readonly number[]; centered?: boolean }) {
  return <span aria-hidden className={`flex w-4 shrink-0 flex-col ${centered ? 'items-center' : 'items-start'}`} style={{ gap }}>
    {widths.map((width, line) => <span key={line} className="h-px bg-current" style={{ width: `${width}%` }} />)}
  </span>;
}

/** Only rows whose effect is not plain from the label and control carry an explanation. */
const APPEARANCE_ROWS: Record<string, { icon: ReactNode; info?: string }> = {
  'Font family': { icon: <TextCursorIcon /> },
  'Text size': { icon: <ZoomIcon /> },
  Spacing: { icon: <LinesGlyph gap={3} /> },
  'Line spacing': { icon: <LinesGlyph gap={4} /> },
  'Paragraph spacing': { icon: <DocumentIcon /> },
  'Letter spacing': { icon: <TextCursorIcon /> },
  Width: { icon: <BookIcon /> },
  'Reading width': { icon: <BookIcon />, info: 'Applies to flowing text and EPUB. PDF pages keep their own width.' },
  Alignment: { icon: <LinesGlyph widths={[100, 60, 100]} /> },
  Preset: { icon: <PaletteIcon />, info: 'Theme follows the app’s accent color; the others use fixed colors.' },
  Segment: { icon: <HighlighterIcon />, info: 'A segment is the passage narrated as one piece. It is often a paragraph or a few sentences, not a single sentence.' },
  Word: { icon: <TextCursorIcon /> },
};

// Block flex, not inline: glyphs of different heights would otherwise shift each segment's text baseline.
const segmentLabel = (glyph: ReactNode, text: ReactNode) => <span className="flex items-center justify-center gap-1.5">{glyph}{text}</span>;

export function ReaderAppearanceSettings({ scope = 'global', showTypography = true, value, onChange }: {
  scope?: 'global' | 'book'; showTypography?: boolean;
  value?: AppearanceDraft; onChange?: (value: AppearanceDraft) => void;
}) {
  const config = useConfig();
  const [moreTypography, setMoreTypography] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const { book, readerType } = useReaderAppearance();
  const saved: AppearanceDraft = {
    typography: scope === 'book' ? book?.settings.typography ?? {} : config.readerTypography,
    highlightAppearance: scope === 'book' ? book?.settings.highlightAppearance ?? {} : config.highlightAppearance,
    ...(scope === 'book' ? { presentation: book?.settings.presentation ?? {} } : { highlightVisibility: getHighlightVisibility(config) }),
  };
  const signature = JSON.stringify(saved);
  const [localDraft, setLocalDraft] = useState<AppearanceDraft | null>(null);
  const pending = value ?? localDraft ?? saved;
  const setPending = onChange ?? setLocalDraft;
  const ownTypography = pending.typography;
  const ownHighlights = pending.highlightAppearance;
  const draft = {
    ...normalizeTypography({ ...config.readerTypography, ...ownTypography }),
    ...normalizeHighlightAppearance({ ...config.highlightAppearance, ...ownHighlights }),
  };
  const visibility = pending.highlightVisibility ?? getHighlightVisibility(config);
  const presentation = scope === 'book'
    ? resolveReaderPresentation(config, readerType, pending.presentation)
    : { ...resolveReaderPresentation(config, readerType), ...appHighlightLayers(visibility) };
  const changePresentation = (patch: Partial<ReaderPresentation>) => {
    if (scope === 'book') setPending({ ...pending, presentation: { ...pending.presentation, ...patch } });
    else setPending({ ...pending, highlightVisibility: setAppHighlightLayers(visibility, patch) });
  };
  const resetPresentation = (key: keyof ReaderPresentation) => {
    const next = { ...pending.presentation }; delete next[key]; setPending({ ...pending, presentation: next });
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(pending) !== signature;

  async function apply() {
    setBusy(true); setError(null);
    try {
      if (scope === 'book') {
        if (!book) throw new Error('Book settings are not ready.');
        await book.update({ typography: pending.typography, highlightAppearance: pending.highlightAppearance, presentation: pending.presentation });
      }
      else await config.updateConfig({ readerTypography: normalizeTypography(ownTypography), highlightAppearance: normalizeHighlightAppearance(ownHighlights), ...pending.highlightVisibility });
      setLocalDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save reader appearance.');
    } finally { setBusy(false); }
  }
  /** Book scope: shown beside a row's label while it overrides any of `keys`; clears them all. */
  const resetField = (kind: 'typography' | 'highlightAppearance', keys: (keyof Values)[], label: string) => {
    const own = kind === 'typography' ? ownTypography : ownHighlights;
    if (scope !== 'book' || !keys.some((key) => Object.hasOwn(own, key))) return null;
    return <ResetIcon label={label} onClick={() => {
      const next = { ...own }; for (const key of keys) delete (next as Partial<Values>)[key];
      setPending({ ...pending, [kind]: next });
    }} />;
  };
  const typographyChanged = scope === 'book' ? Object.keys(ownTypography).length > 0 : JSON.stringify(ownTypography) !== JSON.stringify(DEFAULT_TYPOGRAPHY);
  const highlightsChanged = scope === 'book'
    ? Object.keys(ownHighlights).length > 0 || pending.presentation?.highlightSegment !== undefined || pending.presentation?.highlightWords !== undefined
    : JSON.stringify(ownHighlights) !== JSON.stringify(DEFAULT_HIGHLIGHT_APPEARANCE) || Object.values(visibility).some(shown => !shown);
  const resetHighlights = (from: AppearanceDraft): AppearanceDraft => {
    if (scope === 'book') {
      const next = { ...from.presentation }; delete next.highlightSegment; delete next.highlightWords;
      return { ...from, highlightAppearance: {}, presentation: next };
    }
    return { ...from, highlightAppearance: DEFAULT_HIGHLIGHT_APPEARANCE,
      highlightVisibility: setAppHighlightLayers(visibility, { highlightSegment: true, highlightWords: true }) };
  };
  const change = (kind: 'typography' | 'highlightAppearance', patch: Partial<Values>) => {
    setPending({ ...pending, [kind]: { ...pending[kind], ...patch } });
  };
  const stepper = (key: keyof typeof TYPOGRAPHY_RANGES) => {
    const [min, max, step] = TYPOGRAPHY_RANGES[key];
    return <Stepper label={labels[key]} value={draft[key]} min={min} max={max} step={step}
      suffix={key === 'sizePercent' || key === 'readingWidth' ? '%' : key === 'lineMultiplier' ? '×' : 'em'}
      onChange={(value) => change('typography', { [key]: value })} />;
  };
  const numberRow = (key: keyof typeof TYPOGRAPHY_RANGES) => <Row label={labels[key]} key={key} actions={resetField('typography', [key], `Use global ${labels[key].toLowerCase()}`)}>{stepper(key)}</Row>;
  const fontStyle = (value: string) => ({ fontFamily: READER_FONT_FAMILIES[value as ReaderTypography['fontFamily']] || undefined });

  return <fieldset disabled={busy || (scope === 'book' && !book)} className="min-w-0 space-y-5" style={{ containerType: 'inline-size', containerName: 'reader-appearance' }}>
    {scope === 'book' && <p className="text-xs text-soft">This book inherits your global settings until you change a control.</p>}
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    {scope === 'book' && <ReaderPresentationControls readerType={readerType}
      value={resolveReaderPresentation(config, readerType, pending.presentation)} overrides={pending.presentation}
      onChange={changePresentation} onReset={resetPresentation} />}
    <Section title={showTypography ? 'Typography' : 'Highlights'} variant="group" action={((showTypography && typographyChanged) || highlightsChanged) &&
      <ResetIcon label={scope === 'book' ? `Use global ${showTypography ? 'typography and highlights' : 'highlights'}` : `Reset ${showTypography ? 'typography and highlights' : 'highlights'}`}
        onClick={() => setPending(resetHighlights(showTypography ? { ...pending, typography: scope === 'book' ? {} : DEFAULT_TYPOGRAPHY } : pending))} />}>
      <div aria-label="Typography preview" role="region" className="overflow-hidden text-foreground">
        <button type="button" aria-expanded={previewOpen} onClick={() => setPreviewOpen(current => !current)}
          className="mb-2 flex w-full items-center justify-between text-[10px] uppercase tracking-wide text-faint hover:text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span>Reading preview</span>
          <span className="flex items-center gap-1">{previewOpen ? 'Show less' : 'Show more'}<DisclosureIcon className={`h-3 w-3 transition-transform duration-300 motion-reduce:transition-none ${previewOpen ? '-rotate-90' : 'rotate-90'}`} aria-hidden /></span>
        </button>
        {/* Short by default so the controls stay in view; the fade marks the clip as intentional. */}
        <div role="article" aria-label="Reading sample" className={`mx-auto overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] [mask-image:linear-gradient(to_bottom,black_70%,transparent)] motion-reduce:transition-none ${previewOpen ? 'h-60 lg:h-80' : 'h-24'}`} style={{ width: `${draft.readingWidth}%`, fontFamily: READER_FONT_FAMILIES[draft.fontFamily] || undefined,
          fontSize: `${14 * draft.sizePercent / 100}px`, lineHeight: draft.lineMultiplier, letterSpacing: `${draft.letterSpacing}em`, textAlign: draft.alignment === 'default' ? 'start' : draft.alignment }}>
          {/* The first paragraph is the segment being read: a whole passage, not one sentence. */}
          <p aria-label="Highlight preview" className="-mx-1 rounded-sm px-1" style={{ marginBottom: `${draft.paragraphSpacing}em`, backgroundColor: presentation.highlightSegment ? highlightBackground(draft, 'segment') : undefined }}>
            {PREVIEW_SEGMENT[0]}<span className="rounded-sm" style={{ backgroundColor: presentation.highlightWords ? highlightBackground(draft, 'word') : undefined }}>{PREVIEW_SEGMENT[1]}</span>{PREVIEW_SEGMENT[2]}
          </p>
          {PREVIEW_PARAGRAPHS.map((text) => <p key={text} style={{ marginBottom: `${draft.paragraphSpacing}em` }}>{text}</p>)}
        </div>
      </div>
      {showTypography && <Row label="Font family" actions={resetField('typography', ['fontFamily'], 'Use global font family')}>
        <div className="min-w-0 flex-1"><Select aria-label="Font family" disabled={busy} buttonClassName="h-9 rounded-full py-0 pl-3.5 text-xs font-medium"
          value={SELECT_OPTIONS.fontFamily.find((option) => option.value === draft.fontFamily)} options={SELECT_OPTIONS.fontFamily}
          renderValue={(option) => <span style={fontStyle(option.value)}>{option.label}</span>}
          renderOption={(option) => <span className="flex items-center justify-between gap-4" style={fontStyle(option.value)}><span>{option.label}</span><span aria-hidden className="text-[1rem]">Aa</span></span>}
          onChange={({ value }) => change('typography', { fontFamily: value as ReaderTypography['fontFamily'] })} /></div>
      </Row>}
      {showTypography && numberRow('sizePercent')}
      {showTypography && <div>
      <button type="button" aria-expanded={moreTypography} onClick={() => setMoreTypography(current => !current)}
        className="flex min-h-8 w-full items-center justify-between text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        More typography<DisclosureIcon className={`h-4 w-4 text-faint transition-transform duration-300 motion-reduce:transition-none ${moreTypography ? 'rotate-90' : ''}`} aria-hidden />
      </button>
      <AnimatedCollapse open={moreTypography}><div className="divide-y divide-line-soft [&>*]:py-2.5">
      <Row label="Spacing" wide>
        <SegmentedControl ariaLabel="Spacing presets" className={segmentedClass(3)}
          value={SPACING_PRESETS.find((preset) => draft.lineMultiplier === preset.lineMultiplier && draft.paragraphSpacing === preset.paragraphSpacing && draft.letterSpacing === preset.letterSpacing)?.label ?? ''}
          onChange={(label) => { const { lineMultiplier, paragraphSpacing, letterSpacing } = SPACING_PRESETS.find((option) => option.label === label)!; change('typography', { lineMultiplier, paragraphSpacing, letterSpacing }); }}
          options={SPACING_PRESETS.map(({ label }, index) => ({ value: label, label: segmentLabel(<LinesGlyph gap={index + 1} />, label) }))} />
      </Row>
      {numberRow('lineMultiplier')}
      {numberRow('paragraphSpacing')}
      {numberRow('letterSpacing')}
      <Row label="Width" wide>
        <SegmentedControl ariaLabel="Reading width presets" className={segmentedClass(3)}
          value={String(draft.readingWidth)} onChange={(value) => change('typography', { readingWidth: Number(value) })}
          options={WIDTH_PRESETS.map(({ label, value }) => ({ value: String(value), label: segmentLabel(<LinesGlyph centered widths={[value, value, value * 0.7]} />, label) }))} />
      </Row>
      {numberRow('readingWidth')}
      <Row label="Alignment" wide actions={resetField('typography', ['alignment'], 'Use global alignment')}>
        <SegmentedControl ariaLabel="Alignment" value={draft.alignment} className={segmentedClass(3)} onChange={(value) => change('typography', { alignment: value })}
          options={SELECT_OPTIONS.alignment.map((option) => ({ value: option.value as ReaderTypography['alignment'],
            label: segmentLabel(<LinesGlyph widths={option.value === 'justify' ? [100, 100, 100] : [100, 60, 100]} />, option.value === 'default' ? 'Default' : option.label) }))} />
      </Row>
      </div></AnimatedCollapse>
      </div>}
      <ReaderPresentationControls highlights readerType={readerType} value={presentation} overrides={scope === 'book' ? pending.presentation : undefined}
        onChange={changePresentation} onReset={resetPresentation} />
      <Row label="Preset" wide actions={scope === 'book' && highlightsChanged && <ResetIcon label="Use global highlights" onClick={() => setPending(resetHighlights(pending))} />}>
        <SegmentedControl ariaLabel="Highlight presets" className={segmentedClass(4)}
          value={Object.entries(HIGHLIGHT_PRESETS).find(([, preset]) => Object.entries(preset).every(([key, value]) => draft[key as keyof HighlightAppearance] === value))?.[0] ?? ''}
          onChange={(name) => change('highlightAppearance', HIGHLIGHT_PRESETS[name])}
          options={Object.entries(HIGHLIGHT_PRESETS).map(([name, preset]) => ({ value: name, label: segmentLabel(
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full border border-current" style={{ backgroundColor: highlightBackground({ ...preset, wordOpacity: 1 }, 'word') }} />, name) }))} />
      </Row>
      {(['segment', 'word'] as const).map((layer) => {
        const colorKey = `${layer}Color` as const, opacityKey = `${layer}Opacity` as const;
        const title = layer === 'segment' ? 'Segment' : 'Word';
        const actions = <>
          {draft[colorKey] !== 'theme' && <button type="button" aria-label={`Use theme ${layer} color`} title="Use theme color"
            className="inline-flex h-5 w-5 items-center justify-center rounded text-faint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => change('highlightAppearance', { [colorKey]: 'theme' })}><PaletteIcon className="h-3 w-3" aria-hidden /></button>}
          {resetField('highlightAppearance', [colorKey, opacityKey], `Use global ${layer} highlight`)}
        </>;
        // The swatch sits left of the column so the opacity stepper lines up with the typography steppers.
        const color = <ColorPicker label={title} field="accent" value={draft[colorKey] === 'theme' ? '#ef4444' : draft[colorKey]}
          onChange={(next) => change('highlightAppearance', { [colorKey]: next })} />;
        return <Row label={title} key={layer} actions={actions} lead={color}>
          <Stepper label={`${title} opacity`} value={Math.round(draft[opacityKey] * 100)} min={0} max={100} step={1} suffix="%" onChange={(value) => change('highlightAppearance', { [opacityKey]: value / 100 })} />
        </Row>;
      })}
    </Section>
    {!onChange && (dirty || busy) && <SaveBar saving={busy} onDiscard={() => { setLocalDraft(null); setError(null); }} onSave={() => void apply()} />}
  </fieldset>;
}
