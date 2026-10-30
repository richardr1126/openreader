'use client';

import { useId, useState } from 'react';
import { CheckItem, InfoTip, ResetButton, RowIcon } from '@/components/ui';
import { DisclosureIcon, DocumentIcon } from '@/components/icons/Icons';
import { AnimatedCollapse } from './ExpandableSettingsCard';
import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';

const options: Array<{ kind: ParsedPdfBlockKind; label: string }> = [
  { kind: 'header', label: 'Header' }, { kind: 'footer', label: 'Footer' },
  { kind: 'footnote', label: 'Footnote' }, { kind: 'vision_footnote', label: 'Vision footnote' },
  { kind: 'figure_title', label: 'Figure title' }, { kind: 'doc_title', label: 'Document title' },
  { kind: 'paragraph_title', label: 'Paragraph title' }, { kind: 'abstract', label: 'Abstract' },
  { kind: 'algorithm', label: 'Algorithm' }, { kind: 'aside_text', label: 'Aside text' },
  { kind: 'content', label: 'Content' }, { kind: 'reference', label: 'Reference' },
  { kind: 'reference_content', label: 'Reference content' }, { kind: 'text', label: 'Text' },
  { kind: 'number', label: 'Number' }, { kind: 'formula', label: 'Formula' },
  { kind: 'formula_number', label: 'Formula number' }, { kind: 'table', label: 'Table' },
  { kind: 'chart', label: 'Chart' }, { kind: 'image', label: 'Image' }, { kind: 'seal', label: 'Seal' },
];

/** The header reads like a setting row; the kinds open beneath it. */
export function PdfBlockKindControls({ value, onChange, onReset }: {
  value: ParsedPdfBlockKind[]; onChange: (value: ParsedPdfBlockKind[]) => void; onReset?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div>
    <div className="flex items-center gap-3">
      <RowIcon><DocumentIcon /></RowIcon>
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)}
          className="rounded text-sm font-medium leading-5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          PDF block kinds
        </button>
        {onReset && <ResetButton label="Use app default for PDF block kinds" onClick={onReset} />}
        <InfoTip label="PDF block kinds">Checked kinds are skipped when reading aloud. They still show in page view.</InfoTip>
      </span>
      <button type="button" tabIndex={-1} aria-hidden onClick={() => setOpen(current => !current)}
        className="flex items-center gap-1.5 text-xs tabular-nums text-soft hover:text-foreground">
        {value.length} skipped
        <DisclosureIcon className={`h-3.5 w-3.5 text-faint transition-transform duration-300 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
      </button>
    </div>
    <AnimatedCollapse open={open} id={id}>
      <div className="grid grid-cols-2 gap-x-3 pt-2 pl-10">
        {options.map(option => <CheckItem key={option.kind} label={option.label} checked={value.includes(option.kind)} onChange={enabled => {
          const next = new Set(value); if (enabled) next.add(option.kind); else next.delete(option.kind); onChange([...next]);
        }} />)}
      </div>
    </AnimatedCollapse>
  </div>;
}
