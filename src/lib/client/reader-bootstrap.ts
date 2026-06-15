import type { DocumentType } from '@/types/documents';

export type ReaderBootstrapPhase =
  | 'loading-server-state'
  | 'ready'
  | 'error';

export type ReaderBootstrapQueryState = {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
};

export function resolveReaderBootstrapPhase(input: {
  documentId?: string;
  expectedType: DocumentType;
  metadataType?: DocumentType;
  preferencesReady: boolean;
  preferencesError: boolean;
  metadata: ReaderBootstrapQueryState;
  settings: ReaderBootstrapQueryState;
  progress: ReaderBootstrapQueryState;
}): ReaderBootstrapPhase {
  if (!input.documentId) return 'error';
  if (input.preferencesError || input.metadata.isError || input.settings.isError || input.progress.isError) return 'error';

  if (
    !input.preferencesReady
    ||
    input.metadata.isPending
    || input.settings.isPending
    || input.progress.isPending
    || !input.metadata.isSuccess
    || !input.settings.isSuccess
    || !input.progress.isSuccess
  ) {
    return 'loading-server-state';
  }

  if (!input.metadataType || input.metadataType !== input.expectedType) return 'error';
  return 'ready';
}
