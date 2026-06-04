import { db } from '@/db';
import { documents } from '@/db/schema';
import {
  enqueueDocumentPreview,
} from '@/lib/server/documents/previews';
import { findReusableParsedPdfResult } from '@/lib/server/documents/parsed-pdf-reuse';
import { stringifyDocumentParseState } from '@/lib/server/documents/parse-state';
import { startPdfParseOperation } from '@/lib/server/documents/pdf-parse-operation';
import { enqueueParsePdfJob } from '@/lib/server/jobs/user-pdf-layout-job';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { PDF_PARSER_VERSION } from '@openreader/compute-core';
import type { BaseDocument, DocumentType } from '@/types/documents';

type RegisterUploadedDocumentInput = {
  documentId: string;
  userId: string;
  namespace: string | null;
  name: string;
  type: DocumentType;
  size: number;
  lastModified: number;
};

export async function registerUploadedDocument(input: RegisterUploadedDocumentInput): Promise<BaseDocument> {
  const reusableParsedPdf = input.type === 'pdf'
    ? await findReusableParsedPdfResult(input.documentId)
    : null;
  const startedParse = input.type === 'pdf' && !reusableParsedPdf
    ? await startPdfParseOperation({
      documentId: input.documentId,
      userId: input.userId,
      namespace: input.namespace,
    })
    : null;
  const parsedJsonKey = reusableParsedPdf?.parsedJsonKey ?? null;
  const parseState = input.type === 'pdf'
    ? stringifyDocumentParseState(
      reusableParsedPdf
        ? { status: 'ready', progress: null, updatedAt: Date.now(), parserVersion: PDF_PARSER_VERSION }
        : (startedParse?.parseState ?? { status: 'pending', progress: null, updatedAt: Date.now(), parserVersion: PDF_PARSER_VERSION }),
    )
    : null;

  await db
    .insert(documents)
    .values({
      id: input.documentId,
      userId: input.userId,
      name: input.name,
      type: input.type,
      size: input.size,
      lastModified: input.lastModified,
      filePath: input.documentId,
      parseState,
      parsedJsonKey,
    })
    .onConflictDoUpdate({
      target: [documents.id, documents.userId],
      set: {
        name: input.name,
        type: input.type,
        size: input.size,
        lastModified: input.lastModified,
        filePath: input.documentId,
        parseState,
        parsedJsonKey,
      },
    });

  await enqueueDocumentPreview(
    {
      id: input.documentId,
      type: input.type,
      lastModified: input.lastModified,
    },
    input.namespace,
  ).catch((error) => {
    serverLogger.warn({
      event: 'documents.preview.enqueue.failed',
      degraded: true,
      fallbackPath: 'skip_preview_enqueue',
      documentId: input.documentId,
      error: errorToLog(error),
    }, 'Failed to enqueue document preview');
  });

  if (startedParse) {
    enqueueParsePdfJob({
      documentId: input.documentId,
      userId: input.userId,
      namespace: input.namespace,
      initialOpId: startedParse.workerState.opId,
      initialJobId: startedParse.workerState.jobId,
      initialStatus: startedParse.parseState.status === 'running' ? 'running' : 'pending',
    });
  }

  return {
    id: input.documentId,
    name: input.name,
    type: input.type,
    size: input.size,
    lastModified: input.lastModified,
    scope: 'user',
  };
}
