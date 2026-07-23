import type { PdfParseStatus } from '@/types/parsed-pdf';
import type { ReaderBootstrapResult } from '@/types/reader-bootstrap';

export type ReaderSourceStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type ReaderLoadState = {
  blocking: boolean;
  error: Error | null;
  retryKind: 'bootstrap' | 'source' | 'parse' | 'render' | null;
};

export function deriveReaderLoadState(input: {
  bootstrap: ReaderBootstrapResult;
  sourceStatus: ReaderSourceStatus;
  sourceError?: Error | null;
  parseStatus?: PdfParseStatus | null;
  parseError?: Error | null;
  viewerReady: boolean;
  viewerError?: Error | null;
}): ReaderLoadState {
  const base = { blocking: true };
  if (input.bootstrap.status === 'error') {
    return { ...base, error: new Error(input.bootstrap.message), retryKind: input.bootstrap.retryable ? 'bootstrap' : null };
  }
  if (input.bootstrap.status !== 'ready') {
    return { ...base, error: null, retryKind: null };
  }
  if (input.sourceStatus === 'failed') {
    return { ...base, error: input.sourceError ?? new Error('Failed to load document'), retryKind: 'source' };
  }
  if (input.sourceStatus !== 'ready') {
    return { ...base, error: null, retryKind: null };
  }
  if (input.parseStatus === 'failed') {
    return { ...base, error: input.parseError ?? new Error('Document structure could not be prepared'), retryKind: 'parse' };
  }
  if (input.parseStatus && input.parseStatus !== 'ready') {
    return { ...base, error: null, retryKind: null };
  }
  if (input.viewerError) {
    return { ...base, error: input.viewerError, retryKind: 'render' };
  }
  if (!input.viewerReady) {
    return { ...base, error: null, retryKind: null };
  }
  return { blocking: false, error: null, retryKind: null };
}
