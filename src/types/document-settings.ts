import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';

export interface DocumentSettings {
  schemaVersion: 1;
  pdf?: {
    skipBlockKinds: ParsedPdfBlockKind[];
    margins?: { header: number; footer: number; left: number; right: number };
    chaptersFromSections: boolean;
  };
}

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  schemaVersion: 1,
  pdf: {
    skipBlockKinds: ['header', 'footer', 'footnote', 'vision_footnote'],
    chaptersFromSections: true,
  },
};
