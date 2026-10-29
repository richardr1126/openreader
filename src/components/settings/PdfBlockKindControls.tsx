'use client';

import { useId, useState, type ReactNode } from 'react';
import { CheckItem, InfoTip } from '@/components/ui';
import { DisclosureIcon, RefreshIcon } from '@/components/icons/Icons';
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

export function PdfBlockKindControls({ value, onChange, onReset, children }: {
  value: ParsedPdfBlockKind[]; onChange: (value: ParsedPdfBlockKind[]) => void; onReset?: () => void; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div>
    <div className="flex items-center gap-1">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)}
        className="flex min-h-8 flex-1 items-center gap-2 text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <DisclosureIcon className={`h-3.5 w-3.5 text-faint transition-transform duration-300 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden />PDF block kinds
      </button>
      <InfoTip label="PDF block kinds">Checked kinds are skipped when reading aloud. They stay visible on the page.</InfoTip>
      {onReset && <button type="button" aria-label="Use app default for PDF block kinds" title="Use app default"
        onClick={onReset}
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded align-middle text-faint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <RefreshIcon className="h-3 w-3" aria-hidden />
      </button>}
    </div>
    <AnimatedCollapse open={open} id={id}>
    <div className="grid grid-cols-2 gap-x-3 pt-2">
      {options.map(option => <CheckItem key={option.kind} label={option.label} checked={value.includes(option.kind)} onChange={enabled => {
        const next = new Set(value); if (enabled) next.add(option.kind); else next.delete(option.kind); onChange([...next]);
      }} />)}
    </div>
    {children && <div className="mt-2 border-t border-line-soft pt-2">{children}</div>}
    </AnimatedCollapse>
  </div>;
}
