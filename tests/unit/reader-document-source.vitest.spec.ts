import { StrictMode, createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ReaderPayload } from '@/types/reader-bootstrap';
import type { ReaderDocument } from '@/types/documents';
import type { ReaderType } from '@/types/user-state';
import { queryKeys } from '@/lib/client/query-keys';

const mocks = vi.hoisted(() => ({
  getReaderBootstrap: vi.fn(),
  ensureCachedDocument: vi.fn(),
}));

vi.mock('@/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ data: { user: { id: 'reader-test-user' } }, isPending: false }),
}));
vi.mock('@/lib/client/api/reader-bootstrap', () => ({
  getReaderBootstrap: (...args: unknown[]) => mocks.getReaderBootstrap(...args),
  subscribeReaderBootstrap: vi.fn(() => () => undefined),
}));
vi.mock('@/lib/client/cache/documents', () => ({
  ensureCachedDocument: (...args: unknown[]) => mocks.ensureCachedDocument(...args),
}));
vi.mock('@/lib/client/api/documents', () => ({
  putDocumentSettings: vi.fn(async () => undefined),
}));
vi.mock('@/lib/client/api/user-state', () => ({
  putDocumentProgress: vi.fn(async () => undefined),
}));

import { useReaderBootstrap } from '@/hooks/useReaderBootstrap';

function payload(readerType: ReaderType): ReaderPayload {
  const document = {
    id: `doc-${readerType}`,
    name: `fixture.${readerType === 'html' ? 'txt' : readerType}`,
    type: readerType,
    size: 4,
    lastModified: 1,
    contentVersion: 'content-v1',
  };
  const base = {
    documentId: document.id,
    settings: { schemaVersion: 1 as const, language: 'en' },
    plan: {
      planId: 'plan-v1',
      planObjectKey: 'plans/v1.json',
      planSignature: 'signature-v1',
      sessionId: '',
      documentId: document.id,
      readerType,
      plannedCount: 0,
      segments: [],
    },
    initialPosition: null,
  };
  if (readerType === 'pdf') {
    return {
      ...base,
      readerType,
      document: { ...document, type: 'pdf' },
      parsedDocument: {
        schemaVersion: 1,
        documentId: document.id,
        parserVersion: 'test',
        parsedAt: 1,
        pages: [],
      },
    };
  }
  if (readerType === 'epub') {
    return { ...base, readerType, document: { ...document, type: 'epub' } };
  }
  return { ...base, readerType, document: { ...document, type: 'html' } };
}

function sourceDocument(readerType: ReaderType): ReaderDocument {
  const base = {
    id: `doc-${readerType}`,
    name: `fixture.${readerType === 'html' ? 'txt' : readerType}`,
    size: 4,
    lastModified: 1,
    contentVersion: 'content-v1',
  };
  if (readerType === 'html') return { ...base, type: 'html', data: 'Text' };
  if (readerType === 'epub') return { ...base, type: 'epub', data: new ArrayBuffer(4) };
  return { ...base, type: 'pdf', data: new ArrayBuffer(4) };
}

type BootstrapHook = ReturnType<typeof useReaderBootstrap>;
let latest: BootstrapHook | null = null;

function BootstrapProbe({ documentId, nonce }: { documentId: string; nonce: number }) {
  latest = useReaderBootstrap(documentId);
  return createElement('div', {
    'data-source-status': latest.documentSource.status,
    'data-nonce': nonce,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLElement;
let queryClient: QueryClient;
let restoreDom: (() => void) | null = null;

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error('Timed out waiting for reader query state');
}

beforeEach(() => {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: parsed.window,
    document: parsed.document,
    Node: parsed.window.Node,
    Element: parsed.window.Element,
    HTMLElement: parsed.window.HTMLElement,
    Event: parsed.window.Event,
    navigator: parsed.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    defineGlobal(name, value);
  }
  restoreDom = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  };
  container = parsed.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  latest = null;
  mocks.getReaderBootstrap.mockReset();
  mocks.ensureCachedDocument.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  restoreDom?.();
  restoreDom = null;
});

function renderProbe(readerType: ReaderType, nonce: number) {
  return root.render(createElement(
    StrictMode,
    null,
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(BootstrapProbe, { documentId: `doc-${readerType}`, nonce }),
    ),
  ));
}

describe('reader document source acquisition', () => {
  for (const readerType of ['pdf', 'epub', 'html'] as const) {
    test(`shares one deferred ${readerType} source request across Strict Mode and rerenders`, async () => {
      const pendingSource = deferred<ReaderDocument>();
      mocks.getReaderBootstrap.mockResolvedValue({ status: 'ready', payload: payload(readerType) });
      mocks.ensureCachedDocument.mockReturnValue(pendingSource.promise);

      await act(async () => renderProbe(readerType, 0));
      await waitFor(() => mocks.ensureCachedDocument.mock.calls.length === 1);

      for (let index = 1; index <= 50; index += 1) {
        await act(async () => renderProbe(readerType, index));
      }
      expect(mocks.getReaderBootstrap).toHaveBeenCalledTimes(1);
      expect(mocks.ensureCachedDocument).toHaveBeenCalledTimes(1);

      await act(async () => pendingSource.resolve(sourceDocument(readerType)));
      await waitFor(() => latest?.documentSource.status === 'ready');
      expect(mocks.ensureCachedDocument).toHaveBeenCalledTimes(1);
    });
  }

  test('does not retry a failed source until the explicit source retry command', async () => {
    mocks.getReaderBootstrap.mockResolvedValue({ status: 'ready', payload: payload('pdf') });
    mocks.ensureCachedDocument
      .mockRejectedValueOnce(new Error('source unavailable'))
      .mockResolvedValueOnce(sourceDocument('pdf'));

    await act(async () => renderProbe('pdf', 0));
    await waitFor(() => latest?.documentSource.status === 'error');
    expect(mocks.ensureCachedDocument).toHaveBeenCalledTimes(1);

    for (let index = 1; index <= 20; index += 1) {
      await act(async () => renderProbe('pdf', index));
    }
    expect(mocks.ensureCachedDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      await latest?.retryDocumentSource();
    });
    await waitFor(() => latest?.documentSource.status === 'ready');
    expect(mocks.ensureCachedDocument).toHaveBeenCalledTimes(2);
  });

  test('uses a new source query only when document content identity changes', async () => {
    mocks.getReaderBootstrap.mockResolvedValue({ status: 'ready', payload: payload('html') });
    mocks.ensureCachedDocument.mockResolvedValue(sourceDocument('html'));

    await act(async () => renderProbe('html', 0));
    await waitFor(() => latest?.documentSource.status === 'ready');
    expect(mocks.ensureCachedDocument).toHaveBeenCalledTimes(1);

    const nextPayload = payload('html');
    nextPayload.document.contentVersion = 'content-v2';
    queryClient.setQueryData(
      queryKeys.readerBootstrap('reader-test-user', 'doc-html'),
      { status: 'ready', payload: nextPayload },
    );
    await act(async () => renderProbe('html', 1));
    await waitFor(() => mocks.ensureCachedDocument.mock.calls.length === 2);
    expect(mocks.ensureCachedDocument).toHaveBeenCalledTimes(2);
  });
});
