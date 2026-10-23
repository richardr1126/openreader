import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';
import type { ReaderTypography, HighlightAppearance } from '@/lib/shared/reader-appearance';

export interface DocumentSettings {
  schemaVersion: 1;
  language?: string;
  pdf?: {
    skipBlockKinds: ParsedPdfBlockKind[];
  };
  /**
   * This book's own voice and/or model speed, picked for one provider and
   * model. It applies only while that provider and model are in use; otherwise,
   * and for any field left out, the book follows the user's default.
   */
  voiceOverride?: DocumentVoiceOverride;
  typography?: Partial<ReaderTypography>;
  highlightAppearance?: Partial<HighlightAppearance>;
}

export interface DocumentVoiceOverride {
  providerRef: string;
  ttsModel: string;
  voice?: string;
  voiceSpeed?: number;
}

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  schemaVersion: 1,
  language: 'auto',
  pdf: {
    skipBlockKinds: ['header', 'footer', 'footnote', 'vision_footnote'],
  },
};
