import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';
import type { SpeechTextOptions } from '@openreader/tts/speech-text';
import type { VoiceCustomization } from '@openreader/tts/voice-customization';
import type { ReaderTypography, HighlightAppearance } from '@/lib/shared/reader-appearance';
import type { ReaderPresentation } from '@/lib/shared/reader-presentation';

/**
 * What a PDF added before table and chart text was kept (#243) skips by
 * default. Its narration was planned without that text, so keeping this list
 * keeps its plan and cached audio.
 */
export const LEGACY_PDF_SKIP_BLOCK_KINDS: ParsedPdfBlockKind[] = ['header', 'footer', 'footnote', 'vision_footnote'];
export const DEFAULT_PDF_SKIP_BLOCK_KINDS: ParsedPdfBlockKind[] = [...LEGACY_PDF_SKIP_BLOCK_KINDS, 'table', 'chart'];
/** When #243 was merged; PDFs added from then on use the current default. */
export const PDF_TABLE_TEXT_ADDED_AT_MS = Date.UTC(2026, 10, 27, 17, 46, 40);

/** A PDF's default skip list, from when it was added. */
export function defaultPdfSkipBlockKinds(createdAtMs: number | null | undefined): ParsedPdfBlockKind[] {
  return [...(createdAtMs != null && createdAtMs >= PDF_TABLE_TEXT_ADDED_AT_MS ? DEFAULT_PDF_SKIP_BLOCK_KINDS : LEGACY_PDF_SKIP_BLOCK_KINDS)];
}

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
