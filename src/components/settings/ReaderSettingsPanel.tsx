'use client';

import { useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { SaveBar, Section, SegmentedControl, SettingRow, Switch } from '@/components/ui';
import { KeyboardIcon } from '@/components/icons/Icons';
import { ReaderPresentationControls } from './ReaderPresentationControls';
import { resolveReaderPresentation, type ReaderPresentation } from '@/lib/shared/reader-presentation';
import type { AppConfigValues } from '@/types/config';
import type { ReaderType } from '@/types/user-state';

const formats = [{ value: 'pdf' as const, label: 'PDF' }, { value: 'epub' as const, label: 'EPUB' }];
const playbackKeys = [
  ['Space', 'Play or pause'], ['← →', 'Skip back or forward'],
  ['⇧← ⇧→', 'Previous or next page or section'], ['< >', 'Slower or faster'],
];

export function ReaderSettingsPanel() {
  const config = useConfig();
  const [format, setFormat] = useState<ReaderType>('pdf');
  const [draft, setDraft] = useState<Partial<AppConfigValues>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = { ...config, ...draft };
  const dirty = Object.entries(draft).some(([key, entry]) => entry !== config[key as keyof typeof config]);
  const changePresentation = (change: Partial<ReaderPresentation>) => {
    const patch: Partial<AppConfigValues> = {};
    if (change.showsLayout !== undefined && format !== 'html') patch[format === 'pdf' ? 'pdfShowsLayout' : 'epubShowsLayout'] = change.showsLayout;
    if (change.viewType !== undefined) patch.viewType = change.viewType;
    if (change.epubTheme !== undefined) patch.epubTheme = change.epubTheme;
    setDraft(current => ({ ...current, ...patch }));
  };
  const save = async () => {
    setSaving(true); setError(null);
    try { await config.updateConfig(draft); setDraft({}); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save reading settings.'); }
    finally { setSaving(false); }
  };
  return <fieldset disabled={saving || !config.preferencesReady} className="min-w-0 space-y-5">
    <p className="text-xs text-soft">Display defaults for PDF and EPUB books. Each book can override these settings.</p>
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    <SegmentedControl ariaLabel="Document format" value={format} onChange={setFormat} options={formats} className="grid-cols-2" />
    <ReaderPresentationControls readerType={format} value={resolveReaderPresentation(value, format)} onChange={changePresentation} />
    <Section title="Keyboard" variant="group">
      <SettingRow label="Keyboard shortcuts" icon={<KeyboardIcon />} controlClassName="w-auto"
        info="Enable playback keys in every reader. This preference applies to all books.">
        <Switch ariaLabel="Keyboard shortcuts" checked={value.playbackShortcuts} onChange={playbackShortcuts => setDraft(current => ({ ...current, playbackShortcuts }))} />
      </SettingRow>
      {value.playbackShortcuts && <dl aria-label="Playback keys" className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs text-soft">
        {playbackKeys.map(([keys, action]) => <div key={action} className="contents">
          <dt><kbd className="rounded border border-line-soft bg-surface px-1.5 py-0.5 font-mono text-[11px] text-foreground">{keys}</kbd></dt><dd>{action}</dd>
        </div>)}
      </dl>}
    </Section>
    {(dirty || saving) && <SaveBar saving={saving} onDiscard={() => { setDraft({}); setError(null); }} onSave={() => void save()} />}
  </fieldset>;
}
