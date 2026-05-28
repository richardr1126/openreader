import type { AppConfigValues } from '@/types/config';

export const SYNCED_PREFERENCE_KEYS = [
  'viewType',
  'voiceSpeed',
  'audioPlayerSpeed',
  'voice',
  'skipBlank',
  'epubTheme',
  'segmentPreloadDepthPages',
  'segmentPreloadSentenceLookahead',
  'ttsSegmentMaxBlockLength',
  'headerMargin',
  'footerMargin',
  'leftMargin',
  'rightMargin',
  'providerRef',
  'providerType',
  'ttsModel',
  'ttsInstructions',
  'savedVoices',
  'pdfHighlightEnabled',
  'pdfWordHighlightEnabled',
  'epubHighlightEnabled',
  'epubWordHighlightEnabled',
  'htmlHighlightEnabled',
  'htmlWordHighlightEnabled',
] as const;

export type SyncedPreferenceKey = (typeof SYNCED_PREFERENCE_KEYS)[number];
type SyncedPreferences = Pick<AppConfigValues, SyncedPreferenceKey>;
export type SyncedPreferencesPatch = Partial<SyncedPreferences>;

export type ReaderType = 'pdf' | 'epub' | 'html';

export interface DocumentProgressRecord {
  documentId: string;
  readerType: ReaderType;
  location: string;
  progress: number | null;
  clientUpdatedAtMs: number;
  updatedAtMs: number;
}
