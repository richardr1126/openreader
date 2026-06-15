import { describe, expect, test } from 'vitest';
import { resolveReaderBootstrapPhase, type ReaderBootstrapQueryState } from '../../src/lib/client/reader-bootstrap';

const success: ReaderBootstrapQueryState = { isPending: false, isError: false, isSuccess: true };
const pending: ReaderBootstrapQueryState = { isPending: true, isError: false, isSuccess: false };
const failed: ReaderBootstrapQueryState = { isPending: false, isError: true, isSuccess: false };

describe('reader bootstrap phase', () => {
  test('waits for every required server-state query', () => {
    expect(resolveReaderBootstrapPhase({
      documentId: 'doc',
      expectedType: 'pdf',
      metadataType: 'pdf',
      preferencesReady: true,
      preferencesError: false,
      metadata: success,
      settings: pending,
      progress: success,
    })).toBe('loading-server-state');

    expect(resolveReaderBootstrapPhase({
      documentId: 'doc',
      expectedType: 'pdf',
      metadataType: 'pdf',
      preferencesReady: false,
      preferencesError: false,
      metadata: success,
      settings: success,
      progress: success,
    })).toBe('loading-server-state');
  });

  test('is ready only when metadata, settings, and progress are resolved for the expected reader', () => {
    expect(resolveReaderBootstrapPhase({
      documentId: 'doc',
      expectedType: 'epub',
      metadataType: 'epub',
      preferencesReady: true,
      preferencesError: false,
      metadata: success,
      settings: success,
      progress: success,
    })).toBe('ready');
  });

  test('surfaces query failures and reader type mismatches', () => {
    expect(resolveReaderBootstrapPhase({
      documentId: 'doc',
      expectedType: 'html',
      metadataType: 'html',
      preferencesReady: true,
      preferencesError: false,
      metadata: success,
      settings: success,
      progress: failed,
    })).toBe('error');
    expect(resolveReaderBootstrapPhase({
      documentId: 'doc',
      expectedType: 'pdf',
      metadataType: 'epub',
      preferencesReady: true,
      preferencesError: false,
      metadata: success,
      settings: success,
      progress: success,
    })).toBe('error');
  });
});
