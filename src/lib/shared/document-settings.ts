import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
} from '@/types/document-settings';
import { PARSED_PDF_BLOCK_KINDS, type ParsedPdfBlockKind } from '@/types/parsed-pdf';
import { normalizeLanguageTag } from '@/lib/shared/language';

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

export function mergeDocumentSettings(
  defaults: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
  stored: unknown,
): DocumentSettings {
  const base: DocumentSettings = {
    schemaVersion: 1,
    language: defaults.language || 'auto',
    pdf: {
      skipBlockKinds: [...(defaults.pdf?.skipBlockKinds ?? [])],
    },
  };

  if (!stored || typeof stored !== 'object') return base;
  const rec = stored as Record<string, unknown>;
  const rawLanguage = typeof rec.language === 'string' ? rec.language.trim() : '';
  const language = !rawLanguage || rawLanguage.toLowerCase() === 'auto'
    ? 'auto'
    : normalizeLanguageTag(rawLanguage, defaults.language || 'en');
  const pdf = rec.pdf;
  if (!pdf || typeof pdf !== 'object') return { ...base, language };
  const pdfRec = pdf as Record<string, unknown>;

  return {
    schemaVersion: 1,
    language,
    pdf: {
      skipBlockKinds: normalizeSkipKinds(pdfRec.skipBlockKinds),
    },
  };
}
