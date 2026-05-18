import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { UnsupportedComputeError } from '@/lib/server/compute/types';
import { getDocumentBlob, putParsedDocumentBlob } from '@/lib/server/documents/blobstore';
import { getCompute } from '@/lib/server/compute';
import { clearTtsSegmentCache } from '@/lib/server/tts/segments-cache';

interface ParsePdfJobInput {
  documentId: string;
  userId: string;
  namespace: string | null;
}

const running = new Set<string>();

function keyFor(input: ParsePdfJobInput): string {
  return `${input.userId}:${input.documentId}:${input.namespace || ''}`;
}

export async function parsePdfJob(input: ParsePdfJobInput): Promise<void> {
  const key = keyFor(input);
  if (running.has(key)) return;
  running.add(key);

  try {
    await db
      .update(documents)
      .set({ parseStatus: 'running' })
      .where(and(eq(documents.id, input.documentId), eq(documents.userId, input.userId)));

    const pdfBytes = await getDocumentBlob(input.documentId, input.namespace);
    const parsed = await getCompute().parsePdfLayout({
      documentId: input.documentId,
      pdfBytes: new Uint8Array(pdfBytes).buffer,
    });

    const parsedJson = Buffer.from(JSON.stringify(parsed));
    const parsedJsonKey = await putParsedDocumentBlob(input.documentId, parsedJson, input.namespace);

    const cleared = await clearTtsSegmentCache({
      userId: input.userId,
      documentId: input.documentId,
      readerType: 'pdf',
    });
    if (cleared.warning) {
      console.warn('[parsePdfJob] cache invalidation warning', {
        documentId: input.documentId,
        warning: cleared.warning,
      });
    }

    await db
      .update(documents)
      .set({ parseStatus: 'ready', parsedJsonKey })
      .where(and(eq(documents.id, input.documentId), eq(documents.userId, input.userId)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const cause = error instanceof Error ? error.cause : undefined;
    const parseStatus = error instanceof UnsupportedComputeError ? 'unsupported' : 'failed';
    try {
      await db
        .update(documents)
        .set({ parseStatus })
        .where(and(eq(documents.id, input.documentId), eq(documents.userId, input.userId)));
    } catch (statusError) {
      console.error('[parsePdfJob] failed to write parse status', {
        documentId: input.documentId,
        parseStatus,
        error: statusError instanceof Error ? statusError.message : String(statusError),
      });
    }
    console.error('[parsePdfJob] failed', {
      documentId: input.documentId,
      parseStatus,
      error: message,
      ...(stack ? { stack } : {}),
      ...(cause ? { cause: String(cause) } : {}),
    });
  } finally {
    running.delete(key);
  }
}

export function enqueueParsePdfJob(input: ParsePdfJobInput): void {
  Promise.resolve()
    .then(() => parsePdfJob(input))
    .catch((error) => {
      console.error('[parsePdfJob] uncaught error', error);
    });
}
