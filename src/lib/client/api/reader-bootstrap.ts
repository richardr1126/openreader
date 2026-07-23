import { parseApiError } from '@/lib/client/api/http';
import type { ReaderBootstrapResult } from '@/types/reader-bootstrap';

export async function getReaderBootstrap(
  documentId: string,
  options?: { signal?: AbortSignal },
): Promise<ReaderBootstrapResult> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/reader-bootstrap`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options?.signal,
      cache: 'no-store',
    },
  );
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

export function subscribeReaderBootstrap(
  documentId: string,
  onSnapshot: (result: ReaderBootstrapResult) => void,
): () => void {
  const source = new EventSource(
    `/api/documents/${encodeURIComponent(documentId)}/reader-bootstrap/events`,
  );
  source.addEventListener('snapshot', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const result = JSON.parse(event.data) as ReaderBootstrapResult;
      if (result.status !== 'pending' && result.status !== 'ready' && result.status !== 'error') return;
      onSnapshot(result);
      if (result.status !== 'pending') source.close();
    } catch {
      // EventSource reconnects; malformed snapshots do not replace valid cache data.
    }
  });
  return () => source.close();
}
