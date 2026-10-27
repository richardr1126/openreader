import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';
import type { SpeechTextOptions } from '@openreader/tts/speech-text';
import type { VoiceCustomization } from '@openreader/tts/voice-customization';
import type { ReaderTypography, HighlightAppearance } from '@/lib/shared/reader-appearance';
import type { ReaderPresentation } from '@/lib/shared/reader-presentation';

export const DEFAULT_PDF_SKIP_BLOCK_KINDS: ParsedPdfBlockKind[] = ['header', 'footer', 'footnote', 'vision_footnote'];

export interface DocumentSettings {
  schemaVersion: 1;
  language?: string;
  pdf?: {
    skipBlockKinds?: ParsedPdfBlockKind[];
  };
  /**
   * This book's own voice and/or model speed, picked for one provider and
   * model. It applies only while that provider and model are in use; otherwise,
   * and for any field left out, the book follows the user's default.
   */
  voiceOverride?: DocumentVoiceOverride;
  typography?: Partial<ReaderTypography>;
  highlightAppearance?: Partial<HighlightAppearance>;
  speechText?: Partial<SpeechTextOptions>;
  voiceCustomization?: Partial<VoiceCustomization>;
  presentation?: Partial<ReaderPresentation>;
  playback?: { maxSegmentLength?: number };
}

export interface DocumentVoiceOverride {
  providerRef: string;
  ttsModel: string;
  voice?: string;
  voiceSpeed?: number;
}

export type BookSpeechSettings = Pick<DocumentSettings, 'speechText' | 'voiceCustomization' | 'playback' | 'pdf'>;

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  schemaVersion: 1,
  language: 'auto',
};
