import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import type { ReaderBootstrapPhase } from '@/lib/client/reader-bootstrap';
import type { PlaybackPlanLifecycle } from '@/hooks/audio/useTtsPlanController';

export type ReaderLoadPhase =
  | 'opening-document'
  | 'understanding-structure'
  | 'preparing-reading-plan'
  | 'setting-your-place'
  | 'ready';

export type ReaderSourceStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type ReaderLoadState = {
  phase: ReaderLoadPhase;
  blocking: boolean;
  error: Error | null;
  retryKind: 'bootstrap' | 'source' | 'parse' | 'plan' | 'render' | null;
  parseProgress: PdfParseProgress | null;
};

export function deriveReaderLoadState(input: {
  bootstrapPhase: ReaderBootstrapPhase;
  bootstrapError?: Error | null;
  sourceStatus: ReaderSourceStatus;
  sourceError?: Error | null;
  parseStatus?: PdfParseStatus | null;
  parseProgress?: PdfParseProgress | null;
  parseError?: Error | null;
  plan: PlaybackPlanLifecycle;
  viewerReady: boolean;
  viewerError?: Error | null;
}): ReaderLoadState {
  const base = { blocking: true, parseProgress: input.parseProgress ?? null };
  if (input.bootstrapPhase === 'error') {
    return { ...base, phase: 'opening-document', error: input.bootstrapError ?? new Error('Failed to open document'), retryKind: 'bootstrap' };
  }
  if (input.bootstrapPhase !== 'ready') {
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
  if (input.plan.status === 'failed') {
    return { ...base, phase: 'preparing-reading-plan', error: input.plan.error ?? new Error('Reading plan could not be prepared'), retryKind: 'plan' };
  }
  if (input.plan.status !== 'ready') {
    return { ...base, phase: 'preparing-reading-plan', error: null, retryKind: null };
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
