import { parseApiError } from '@/lib/client/api/http';
import type { ReaderBootstrapResult } from '@/types/reader-bootstrap';

export async function getReaderBootstrap(
  documentId: string,
  restartPdfOperationId?: string,
): Promise<ReaderBootstrapResult> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/reader-bootstrap`,
    {
      method: 'POST',
      cache: 'no-store',
      ...(restartPdfOperationId ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restartPdfOperationId }),
      } : {}),
    },
  );
  if (response.status === 404) {
    return { status: 'error', message: 'Document not found.', retryable: false, notFound: true };
  }
  if (!response.ok && response.status !== 202) {
    const body = (await response.json().catch(() => null)) as Partial<ReaderBootstrapResult> | null;
    if (body?.status === 'error' && typeof body.message === 'string') {
      return {
        status: 'error',
        message: body.message,
        retryable: body.retryable !== false,
      };
    }
    throw await parseApiError(response, 'Failed to prepare reader');
  }
  return (await response.json()) as ReaderBootstrapResult;
}

const RECONNECT_DELAY_MS = 2_000;
const MAX_CONSECUTIVE_RECONNECTS = 5;

/**
 * Follows reader preparation over SSE until it settles. A browser EventSource
 * stops for good when a reconnect gets a non-200 response, so a closed source
 * is reopened here; repeated failures settle as a retryable error rather than
 * leaving the reader waiting on a stream that will never deliver.
 */
export function subscribeReaderBootstrap(
  documentId: string,
  onSnapshot: (result: ReaderBootstrapResult) => void,
  options?: { operationId?: string | null },
): () => void {
  const params = new URLSearchParams();
  if (options?.operationId) params.set('operationId', options.operationId);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const url = `/api/documents/${encodeURIComponent(documentId)}/reader-bootstrap/events${query}`;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let stopped = false;

  const connect = () => {
    const current = new EventSource(url);
    source = current;
    current.addEventListener('snapshot', (event) => {
      if (!(event instanceof MessageEvent)) return;
      try {
        const result = JSON.parse(event.data) as ReaderBootstrapResult;
        if (result.status !== 'pending' && result.status !== 'ready' && result.status !== 'error') return;
        failures = 0;
        if (result.status !== 'pending') {
          stopped = true;
          current.close();
        }
        onSnapshot(result);
      } catch {
        // EventSource reconnects; malformed snapshots do not replace valid cache data.
      }
    });
    current.addEventListener('error', () => {
      if (stopped || current.readyState !== EventSource.CLOSED) return;
      if (++failures > MAX_CONSECUTIVE_RECONNECTS) {
        stopped = true;
        onSnapshot({
          status: 'error',
          message: 'Lost connection while preparing the reader.',
          retryable: true,
        });
        return;
      }
      retry = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    source?.close();
  };
}
