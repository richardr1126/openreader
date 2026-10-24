'use client';

import { Section, Select, SettingRow, Switch } from '@/components/ui';
import { BookIcon, DocumentIcon, HighlighterIcon, PaletteIcon, RefreshIcon, TextCursorIcon } from '@/components/icons/Icons';
import type { ReaderPresentation } from '@/lib/shared/reader-presentation';
import type { ReaderType } from '@/types/user-state';
import type { ReactNode } from 'react';

const pageModes = [
  { value: 'single' as const, label: 'Single page' },
  { value: 'dual' as const, label: 'Two pages' },
  { value: 'scroll' as const, label: 'Continuous scroll' },
];

export function ReaderPresentationControls({ readerType, value, onChange, overrides, onReset, highlights = false }: {
  readerType: ReaderType;
  value: ReaderPresentation;
  onChange: (change: Partial<ReaderPresentation>) => void;
  overrides?: Partial<ReaderPresentation>;
  onReset?: (key: keyof ReaderPresentation) => void;
  highlights?: boolean;
}) {
  const reset = (key: keyof ReaderPresentation, label: string) => overrides?.[key] !== undefined && onReset
    ? <button type="button" aria-label={`Use app default for ${label.toLowerCase()}`} title="Use app default"
      onClick={() => onReset(key)} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <RefreshIcon className="h-3 w-3" aria-hidden />
    </button> : null;
  const toggle = (key: 'showsLayout' | 'epubTheme' | 'highlightSegment' | 'highlightWords', label: string, icon: ReactNode, info: string) => (
    <SettingRow label={label} icon={icon} info={info} labelAction={reset(key, label)} controlClassName="w-auto">
      <Switch ariaLabel={label} checked={value[key]} onChange={next => onChange({ [key]: next })} />
    </SettingRow>
  );
  if (highlights) return <>
    {toggle('highlightSegment', 'Highlight segment', <HighlighterIcon />, 'Show the narration segment being read. Word highlighting can remain enabled independently.')}
    {toggle('highlightWords', 'Highlight words', <TextCursorIcon />, 'Highlight words in time with the spoken audio.')}
  </>;
  return <>
    {readerType !== 'html' && <Section title="Display" variant="group">
      {toggle('showsLayout', readerType === 'pdf' ? 'Show the pages' : 'Show the book', readerType === 'pdf' ? <DocumentIcon /> : <BookIcon />,
        'Show the original layout. Turn off to read the same document as flowing text.')}
      {readerType === 'pdf' && value.showsLayout && <SettingRow label="Page mode" icon={<BookIcon />} labelAction={reset('viewType', 'Page mode')}
        info="Read one page, two facing pages, or scroll continuously. Continuous scroll may be slower on large PDFs.">
        <Select aria-label="Page mode" value={pageModes.find(option => option.value === value.viewType)} options={pageModes}
          onChange={option => onChange({ viewType: option.value })} />
      </SettingRow>}
      {readerType === 'epub' && value.showsLayout && toggle('epubTheme', 'Use app theme', <PaletteIcon />,
        'Apply the app’s text and background colors to the EPUB. Turn off to preserve the publisher’s colors.')}
    </Section>}
  </>;
}
