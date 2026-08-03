import type { DocumentSettings } from '@/types/document-settings';
import type { BaseDocument } from '@/types/documents';
import type { ReaderInitialPosition } from '@/lib/shared/reader-position';
import type { TtsPlaybackPlan } from '@/lib/shared/playback-plan';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';
import type { ReaderType } from '@/types/user-state';

export type ReaderBootstrapProgress = {
  kind: 'pdf-parse';
  phase: 'queued' | 'parsing' | 'merging';
  pagesParsed: number;
  totalPages: number;
};

export type ReaderBootstrapRestart = {
  operationId: string;
  progress?: ReaderBootstrapProgress;
};

type ReaderPayloadBase<T extends ReaderType> = {
  documentId: string;
  readerType: T;
  document: BaseDocument & { type: T };
  settings: DocumentSettings;
  plan: TtsPlaybackPlan;
  initialPosition: ReaderInitialPosition;
};

export type PdfReaderPayload = ReaderPayloadBase<'pdf'> & {
  parsedDocument: ParsedPdfDocument;
};

export type ReaderPayload =
  | PdfReaderPayload
  | ReaderPayloadBase<'epub'>
  | ReaderPayloadBase<'html'>;

export type ReaderBootstrapResult =
  | { status: 'pending'; progress?: ReaderBootstrapProgress; operationId?: string }
  | { status: 'ready'; payload: ReaderPayload }
  | { status: 'error'; message: string; retryable: boolean };
