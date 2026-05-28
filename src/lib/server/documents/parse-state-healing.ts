import { and, eq } from 'drizzle-orm';
import { getComputeOpStaleMs } from '@openreader/compute-core';
import { db } from '@/db';
import { documents } from '@/db/schema';
import {
  isDocumentParseStateStale,
  parseDocumentParseState,
  stringifyDocumentParseState,
  type DocumentParseState,
} from '@/lib/server/documents/parse-state';

export async function healStaleDocumentParseState(input: {
  documentId: string;
  userId: string;
  state: DocumentParseState;
}): Promise<DocumentParseState> {
  const staleMs = getComputeOpStaleMs();
  if (!isDocumentParseStateStale(input.state, staleMs)) return input.state;

  const nextState = parseDocumentParseState(stringifyDocumentParseState({
    status: 'failed',
    progress: null,
    updatedAt: Date.now(),
    error: `Parse state stale for more than ${staleMs}ms; marked failed for retry`,
  }));

  await db
    .update(documents)
    .set({ parseState: stringifyDocumentParseState(nextState) })
    .where(and(eq(documents.id, input.documentId), eq(documents.userId, input.userId)));

  return nextState;
}
