import type { AppConfigValues } from '@/types/config';

export const SYNCED_PREFERENCE_KEYS = [
  'viewType',
  'voiceSpeed',
  'audioPlayerSpeed',
  'voice',
  'epubTheme',
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
  'documentListState',
] as const;

export type SyncedPreferenceKey = (typeof SYNCED_PREFERENCE_KEYS)[number];
type SyncedPreferences = Pick<AppConfigValues, SyncedPreferenceKey>;
export type SyncedPreferencesPatch = Partial<SyncedPreferences>;

export type ReaderType = 'pdf' | 'epub' | 'html';

export type EpubProgressLocator = {
  schemaVersion: 1;
  spineHref: string;
  spineIndex: number;
  charOffset: number;
};

type DocumentProgressRecordBase = {
  documentId: string;
  progress: number | null;
  clientUpdatedAtMs: number;
  updatedAtMs: number;
};

export type DocumentProgressRecord = DocumentProgressRecordBase & (
  | { readerType: 'pdf' | 'html'; location: string }
  | { readerType: 'epub'; locator: EpubProgressLocator }
);

type DocumentProgressPayloadBase = {
  documentId: string;
  progress?: number | null;
  clientUpdatedAtMs?: number;
};

export type DocumentProgressPayload = DocumentProgressPayloadBase & (
  | { readerType: 'pdf' | 'html'; location: string }
  | { readerType: 'epub'; locator: EpubProgressLocator }
);

export type ScheduleDocumentProgress = (
  payload: DocumentProgressPayload,
  debounceMs?: number,
) => void;
