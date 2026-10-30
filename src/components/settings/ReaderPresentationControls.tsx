'use client';

import { ResetButton, Section, Select, SettingRow, Switch } from '@/components/ui';
import { BookIcon, DocumentIcon, HighlighterIcon, PaletteIcon, TextCursorIcon } from '@/components/icons/Icons';
import type { ReaderPresentation } from '@/lib/shared/reader-presentation';
import type { ReaderType } from '@/types/user-state';
import type { ReactNode } from 'react';

const pageModes = [
  { value: 'single' as const, label: 'Single page' },
  { value: 'dual' as const, label: 'Two pages' },
  { value: 'scroll' as const, label: 'Continuous scroll' },
];

export function ReaderPresentationControls({ readerType, value, onChange, overrides, onReset, highlights = false, action }: {
  readerType: ReaderType;
  value: ReaderPresentation;
  onChange: (change: Partial<ReaderPresentation>) => void;
  overrides?: Partial<ReaderPresentation>;
  onReset?: (key: keyof ReaderPresentation) => void;
  highlights?: boolean;
  /** Shown in the Display header, such as the format the defaults apply to. */
  action?: ReactNode;
}) {
  const reset = (key: keyof ReaderPresentation, label: string) => overrides?.[key] !== undefined && onReset
    ? <ResetButton label={`Use app default for ${label.toLowerCase()}`} onClick={() => onReset(key)} /> : null;
  const toggle = (key: 'showsLayout' | 'epubTheme' | 'highlightSegment' | 'highlightWords', label: string, icon: ReactNode, info?: string) => (
    <SettingRow label={label} icon={icon} info={info} labelAction={reset(key, label)} controlClassName="w-auto">
      <Switch ariaLabel={label} checked={value[key]} onChange={next => onChange({ [key]: next })} />
    </SettingRow>
  );
  if (highlights) return <>
    {toggle('highlightSegment', 'Highlight segment', <HighlighterIcon />, 'Shade the segment being narrated: the passage read as one piece, often a paragraph or a few sentences.')}
    {toggle('highlightWords', 'Highlight words', <TextCursorIcon />)}
  </>;
  return <>
    {readerType !== 'html' && <Section title="Display" variant="group" action={action}>
      {toggle('showsLayout', readerType === 'pdf' ? 'Show the pages' : 'Show the book', readerType === 'pdf' ? <DocumentIcon /> : <BookIcon />,
        'Off shows the same document as flowing text, which follows your typography settings.')}
      {readerType === 'pdf' && value.showsLayout && <SettingRow label="Page mode" icon={<BookIcon />} labelAction={reset('viewType', 'Page mode')}
        info="Continuous scroll can be slower on large PDFs.">
        <Select aria-label="Page mode" value={pageModes.find(option => option.value === value.viewType)} options={pageModes}
          onChange={option => onChange({ viewType: option.value })} />
      </SettingRow>}
      {readerType === 'epub' && value.showsLayout && toggle('epubTheme', 'Use app theme', <PaletteIcon />,
        'Off keeps the publisher’s own text and background colors.')}
    </Section>}
  </>;
}
