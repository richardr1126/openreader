import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import type { ReaderBootstrapResult } from '@/types/reader-bootstrap';

export type ReaderLoadPhase =
  | 'opening-document'
  | 'understanding-structure'
  | 'setting-your-place'
  | 'ready';

export type ReaderSourceStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type ReaderLoadState = {
  phase: ReaderLoadPhase;
  blocking: boolean;
  error: Error | null;
  retryKind: 'bootstrap' | 'source' | 'parse' | 'render' | null;
  parseProgress: PdfParseProgress | null;
};

export function deriveReaderLoadState(input: {
  bootstrap: ReaderBootstrapResult;
  sourceStatus: ReaderSourceStatus;
  sourceError?: Error | null;
  parseStatus?: PdfParseStatus | null;
  parseProgress?: PdfParseProgress | null;
  parseError?: Error | null;
  viewerReady: boolean;
  viewerError?: Error | null;
}): ReaderLoadState {
  const base = { blocking: true, parseProgress: input.parseProgress ?? null };
  if (input.bootstrap.status === 'error') {
    return { ...base, phase: 'opening-document', error: new Error(input.bootstrap.message), retryKind: input.bootstrap.retryable ? 'bootstrap' : null };
  }
  if (input.bootstrap.status !== 'ready') {
    return { ...base, phase: 'opening-document', error: null, retryKind: null };
  }
  if (input.sourceStatus === 'failed') {
    return { ...base, phase: 'opening-document', error: input.sourceError ?? new Error('Failed to load document'), retryKind: 'source' };
  }
  if (input.sourceStatus !== 'ready') {
    return { ...base, phase: 'opening-document', error: null, retryKind: null };
  }
  if (input.parseStatus === 'failed') {
    return { ...base, phase: 'understanding-structure', error: input.parseError ?? new Error('Document structure could not be prepared'), retryKind: 'parse' };
  }
  if (input.parseStatus && input.parseStatus !== 'ready') {
    return { ...base, phase: 'understanding-structure', error: null, retryKind: null };
  }
  if (input.viewerError) {
    return { ...base, phase: 'setting-your-place', error: input.viewerError, retryKind: 'render' };
  }
  if (!input.viewerReady) {
    return { ...base, phase: 'setting-your-place', error: null, retryKind: null };
  }
  return {
    phase: 'ready',
    blocking: false,
    error: null,
    retryKind: null,
    parseProgress: input.parseProgress ?? null,
  };
}
