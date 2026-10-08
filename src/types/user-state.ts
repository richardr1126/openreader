import type { AppConfigValues } from '@/types/config';
import type { ReadingPosition } from '@/lib/shared/reading-position';

export const SYNCED_PREFERENCE_KEYS = [
  'viewType',
  'voiceSpeed',
  'audioPlayerSpeed',
  'voice',
  'epubTheme',
  'readerShowsLayout',
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

/** Saved reading progress: the playback cursor (see `@/lib/shared/reading-position`). */
export type DocumentProgressRecord = ReadingPosition & {
  documentId: string;
  /** Fraction of the plan before the cursor, for library display. */
  progress: number | null;
  clientUpdatedAtMs: number;
  updatedAtMs: number;
};

export type DocumentProgressPayload = {
  documentId: string;
  segmentKey: string;
  segmentOrdinal: number;
  progress?: number | null;
  clientUpdatedAtMs?: number;
};

export type ScheduleDocumentProgress = (
  payload: DocumentProgressPayload,
  debounceMs?: number,
) => void;
