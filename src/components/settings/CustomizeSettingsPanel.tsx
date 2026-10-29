'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { getCustomThemeColors, type CustomThemeColors, useTheme } from '@/contexts/ThemeContext';
import { KeyboardIcon } from '@/components/icons/Icons';
import { SaveBar, Section, SegmentedControl, SettingRow, Switch } from '@/components/ui';
import { normalizeHighlightAppearance, normalizeTypography } from '@/lib/shared/reader-appearance';
import { getHighlightVisibility, resolveReaderPresentation, type ReaderPresentation } from '@/lib/shared/reader-presentation';
import type { AppConfigValues } from '@/types/config';
import type { ReaderType } from '@/types/user-state';
import { ReaderAppearanceSettings, type AppearanceDraft } from './ReaderAppearanceSettings';
import { ReaderPresentationControls } from './ReaderPresentationControls';
import { ThemePicker, type ThemeId } from './ThemePicker';

const formats = [{ value: 'pdf' as const, label: 'PDF' }, { value: 'epub' as const, label: 'EPUB' }];
const playbackKeys = [
  ['Space', 'Play or pause'], ['← →', 'Skip back or forward'],
  ['⇧← ⇧→', 'Previous or next page or section'], ['< >', 'Slower or faster'],
];

/** Theme, display, typography, highlights and shortcuts: every look-and-feel default, saved together. */
export function CustomizeSettingsPanel() {
  const config = useConfig();
  const { theme, setTheme: applyTheme, applyCustomColors } = useTheme();
  const [customColors, setCustomColors] = useState<CustomThemeColors>(getCustomThemeColors);
  // Theme choices preview live on the page; this holds what Discard (or leaving unapplied) restores.
  const [themeBaseline, setThemeBaseline] = useState<{ theme: ThemeId; colors: CustomThemeColors } | null>(null);
  const savedAppearance = { typography: config.readerTypography, highlightAppearance: config.highlightAppearance, highlightVisibility: getHighlightVisibility(config) };
  const [appearanceDraft, setAppearance] = useState<AppearanceDraft | null>(null);
  const appearance = appearanceDraft ?? savedAppearance;
  const [format, setFormat] = useState<ReaderType>('pdf');
  const [readerDraft, setReaderDraft] = useState<Partial<AppConfigValues>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reader = { ...config, ...readerDraft };
  const appearanceDirty = JSON.stringify(appearance) !== JSON.stringify(savedAppearance);
  const readerDirty = Object.entries(readerDraft).some(([key, entry]) => entry !== config[key as keyof typeof config]);
  const themeDirty = themeBaseline !== null
    && (themeBaseline.theme !== theme || JSON.stringify(themeBaseline.colors) !== JSON.stringify(customColors));
  const dirty = appearanceDirty || readerDirty || themeDirty;

  const holdBaseline = () => setThemeBaseline((current) => current ?? { theme, colors: customColors });
  const selectTheme = (next: ThemeId) => { holdBaseline(); applyTheme(next); };
  const changeCustomColors = (next: CustomThemeColors) => { holdBaseline(); setCustomColors(next); applyCustomColors(next); };
  const restoreTheme = useCallback((baseline: { theme: ThemeId; colors: CustomThemeColors }) => {
    // Colors first: switching back to custom reads the stored custom colors.
    applyCustomColors(baseline.colors);
    applyTheme(baseline.theme);
  }, [applyCustomColors, applyTheme]);
  const changePresentation = (change: Partial<ReaderPresentation>) => {
    const patch: Partial<AppConfigValues> = {};
    if (change.showsLayout !== undefined && format !== 'html') patch[format === 'pdf' ? 'pdfShowsLayout' : 'epubShowsLayout'] = change.showsLayout;
    if (change.viewType !== undefined) patch.viewType = change.viewType;
    if (change.epubTheme !== undefined) patch.epubTheme = change.epubTheme;
    setReaderDraft((current) => ({ ...current, ...patch }));
  };
  const discard = () => {
    if (themeBaseline) { restoreTheme(themeBaseline); setCustomColors(themeBaseline.colors); setThemeBaseline(null); }
    setAppearance(null); setReaderDraft({}); setError(null);
  };
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const patch: Partial<AppConfigValues> = { ...readerDraft };
      if (appearanceDirty) Object.assign(patch, { readerTypography: normalizeTypography(appearance.typography), highlightAppearance: normalizeHighlightAppearance(appearance.highlightAppearance), ...appearance.highlightVisibility });
      if (Object.keys(patch).length) await config.updateConfig(patch);
      setThemeBaseline(null); setAppearance(null); setReaderDraft({});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your changes.');
    } finally { setSaving(false); }
  };
  // Leaving the panel drops unapplied edits, as every other settings draft does; that includes the theme preview.
  const unappliedTheme = useRef<typeof themeBaseline>(null);
  unappliedTheme.current = themeDirty ? themeBaseline : null;
  const restoreOnLeave = useRef(restoreTheme);
  restoreOnLeave.current = restoreTheme;
  useEffect(() => () => { if (unappliedTheme.current) restoreOnLeave.current(unappliedTheme.current); }, []);

  return <fieldset disabled={saving || !config.preferencesReady} className="min-w-0 space-y-6">
    <p className="text-xs text-soft">Defaults for every book. Each book can override its display, typography and highlights.</p>
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    <Section title="Theme" variant="group">
      <div className="!py-3"><ThemePicker theme={theme} customColors={customColors} onSelect={selectTheme} onCustomColorsChange={changeCustomColors} /></div>
    </Section>
    <ReaderPresentationControls readerType={format} value={resolveReaderPresentation(reader, format)} onChange={changePresentation}
      action={<SegmentedControl ariaLabel="Document format" value={format} onChange={setFormat} options={formats} className="w-32 grid-cols-2 [&>button]:py-0.5" />} />
    <ReaderAppearanceSettings value={appearance} onChange={setAppearance} />
    <Section title="Keyboard" variant="group">
      <SettingRow label="Keyboard shortcuts" icon={<KeyboardIcon />} controlClassName="w-auto">
        <Switch ariaLabel="Keyboard shortcuts" checked={reader.playbackShortcuts} onChange={(playbackShortcuts) => setReaderDraft((current) => ({ ...current, playbackShortcuts }))} />
      </SettingRow>
      {reader.playbackShortcuts && <dl aria-label="Playback keys" className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs text-soft">
        {playbackKeys.map(([keys, action]) => <div key={action} className="contents">
          <dt><kbd className="rounded border border-line-soft bg-surface px-1.5 py-0.5 font-mono text-[11px] text-foreground">{keys}</kbd></dt><dd>{action}</dd>
        </div>)}
      </dl>}
    </Section>
    {(dirty || saving) && <SaveBar saving={saving} onDiscard={discard} onSave={() => void save()} />}
  </fieldset>;
}
