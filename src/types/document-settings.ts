import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';

export interface DocumentSettings {
  schemaVersion: 1;
  pdf?: {
    skipBlockKinds: ParsedPdfBlockKind[];
  };
}

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  schemaVersion: 1,
  pdf: {
    skipBlockKinds: ['header', 'footer', 'footnote', 'vision_footnote'],
  },
};
