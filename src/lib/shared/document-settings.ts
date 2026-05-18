import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
} from '@/types/document-settings';
import { PARSED_PDF_BLOCK_KINDS, type ParsedPdfBlockKind } from '@/types/parsed-pdf';

function normalizeSkipKinds(value: unknown): ParsedPdfBlockKind[] {
  if (!Array.isArray(value)) return [...(DEFAULT_DOCUMENT_SETTINGS.pdf?.skipBlockKinds ?? [])];
  const allow = new Set(PARSED_PDF_BLOCK_KINDS);
  const out: ParsedPdfBlockKind[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (!allow.has(entry as ParsedPdfBlockKind)) continue;
    out.push(entry as ParsedPdfBlockKind);
  }
  return Array.from(new Set(out));
}

type PdfMargins = { header: number; footer: number; left: number; right: number };

function normalizeMargins(value: unknown): PdfMargins | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const header = Number(rec.header);
  const footer = Number(rec.footer);
  const left = Number(rec.left);
  const right = Number(rec.right);
  if (![header, footer, left, right].every((n) => Number.isFinite(n))) return undefined;
  return { header, footer, left, right };
}

export function mergeDocumentSettings(
  defaults: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
  stored: unknown,
): DocumentSettings {
  const base: DocumentSettings = {
    schemaVersion: 1,
    pdf: {
      skipBlockKinds: [...(defaults.pdf?.skipBlockKinds ?? [])],
      chaptersFromSections: defaults.pdf?.chaptersFromSections ?? true,
      ...(defaults.pdf?.margins ? { margins: defaults.pdf.margins } : {}),
    },
  };

  if (!stored || typeof stored !== 'object') return base;
  const rec = stored as Record<string, unknown>;
  const pdf = rec.pdf;
  if (!pdf || typeof pdf !== 'object') return base;
  const pdfRec = pdf as Record<string, unknown>;

  return {
    schemaVersion: 1,
    pdf: {
      skipBlockKinds: normalizeSkipKinds(pdfRec.skipBlockKinds),
      chaptersFromSections:
        typeof pdfRec.chaptersFromSections === 'boolean'
          ? pdfRec.chaptersFromSections
          : (base.pdf?.chaptersFromSections ?? true),
      ...(normalizeMargins(pdfRec.margins) ? { margins: normalizeMargins(pdfRec.margins) } : {}),
    },
  };
}
