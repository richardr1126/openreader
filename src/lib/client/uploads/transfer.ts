type TransferSource = {
  name: string;
  size: number;
  body: Blob | ArrayBuffer | Uint8Array;
};

type PreparedUpload = {
  token: string;
  url: string;
  headers?: Record<string, string>;
};

type TransferProgress = {
  phase: 'transferring';
  sourceIndex: number;
  loadedBytes: number;
  totalBytes: number;
};

const DOCUMENT_UPLOAD_CONCURRENCY = 3;

function toFetchBody(body: TransferSource['body']): BodyInit {
  if (body instanceof Blob || body instanceof ArrayBuffer) return body;
  return body as unknown as BodyInit;
}

function toXhrBody(body: TransferSource['body']): XMLHttpRequestBodyInit {
  if (body instanceof Blob || body instanceof ArrayBuffer) return body;
  return body as Uint8Array<ArrayBuffer>;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Document upload aborted', 'AbortError');
}

function transferOne(input: {
  source: TransferSource;
  sourceIndex: number;
  upload: PreparedUpload;
  signal: AbortSignal;
  onProgress?: (event: TransferProgress) => void;
}): Promise<void> {
  if (!input.onProgress || typeof XMLHttpRequest === 'undefined') {
    return fetch(input.upload.url, {
      method: 'PUT',
      headers: new Headers(input.upload.headers || {}),
      body: toFetchBody(input.source.body),
      signal: input.signal,
    }).then((response) => {
      if (!response.ok && response.status !== 412) {
        throw new Error(`Document upload failed with status ${response.status}`);
      }
      input.onProgress?.({
        phase: 'transferring',
        sourceIndex: input.sourceIndex,
        loadedBytes: input.source.size,
        totalBytes: input.source.size,
      });
    });
  }

  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cleanup = () => input.signal.removeEventListener('abort', handleAbort);
    const handleAbort = () => xhr.abort();

    xhr.open('PUT', input.upload.url);
    for (const [name, value] of Object.entries(input.upload.headers || {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      input.onProgress?.({
        phase: 'transferring',
        sourceIndex: input.sourceIndex,
        loadedBytes: Math.min(input.source.size, Math.max(0, event.loaded)),
        totalBytes: input.source.size,
      });
    };
    xhr.onload = () => {
      cleanup();
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 412) {
        input.onProgress?.({
          phase: 'transferring',
          sourceIndex: input.sourceIndex,
          loadedBytes: input.source.size,
          totalBytes: input.source.size,
        });
        resolve();
        return;
      }
      reject(new Error(`Document upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('Document upload failed because the storage connection was interrupted'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(abortReason(input.signal));
    };

    if (input.signal.aborted) {
      reject(abortReason(input.signal));
      return;
    }
    input.signal.addEventListener('abort', handleAbort, { once: true });
    input.onProgress?.({
      phase: 'transferring',
      sourceIndex: input.sourceIndex,
      loadedBytes: 0,
      totalBytes: input.source.size,
    });
    xhr.send(toXhrBody(input.source.body));
  });
}

export async function transferPreparedDocumentUploads(input: {
  sources: TransferSource[];
  uploads: PreparedUpload[];
  signal: AbortSignal;
  onProgress?: (event: TransferProgress) => void;
}): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(DOCUMENT_UPLOAD_CONCURRENCY, input.sources.length) },
    async () => {
      while (nextIndex < input.sources.length) {
        if (input.signal.aborted) throw abortReason(input.signal);
        const sourceIndex = nextIndex;
        nextIndex += 1;
        const source = input.sources[sourceIndex];
        const upload = input.uploads[sourceIndex];
        if (!source || !upload?.url || !upload.token) {
          throw new Error(`Missing prepared upload for document ${source?.name ?? sourceIndex + 1}`);
        }

        try {
          await transferOne({
            source,
            sourceIndex,
            upload,
            signal: input.signal,
            onProgress: input.onProgress,
          });
        } catch (error) {
          if (input.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : 'unknown upload error';
          throw new Error(`Failed to upload ${source.name}: ${message}`, { cause: error });
        }
      }
    },
  );
  await Promise.all(workers);
}
