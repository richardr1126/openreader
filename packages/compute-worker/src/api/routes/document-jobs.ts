import { hashOpKey } from '../../infrastructure/nats-adapters';
import { isNotFound } from '../../infrastructure/storage';
import type { WorkerOperationRequest } from '../../operations/contracts';
import {
  buildDocumentConversionOperationKey,
  buildDocumentPreviewOperationKey,
  buildPdfOperationKey,
} from '../../operations/keys';
import {
  documentConversionMetadataArtifactKey,
  parsedPdfArtifactKey,
} from '../../storage/artifact-addressing';
import type {
  DocumentConversionArtifactMetadata,
} from '../../operations/contracts';
import { inspectDocumentPreviewMetadata, readDocumentPreviewMetadata } from '../../storage/document-preview-metadata';
import { toComputeOperation } from '../compute-operation';
import type { ComputeWorkerRouteContext } from '../route-context';
import {
  apiErrorResponseSchema,
  computeOperationSchema,
  documentConversionOperationCreateSchema,
  documentConversionResolutionSchema,
  documentConversionResolveSchema,
  documentPreviewOperationCreateSchema,
  documentPreviewResolutionSchema,
  documentPreviewResolveSchema,
  jsonSchema,
  pdfLayoutResolutionSchema,
  pdfOperationCreateSchema,
  pdfResolveSchema,
} from '../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

function readConversionMetadata(
  context: ComputeWorkerRouteContext,
  input: typeof documentConversionResolveSchema._output,
): Promise<DocumentConversionArtifactMetadata | null> {
  return inspectConversionMetadata(context, input).catch(() => null);
}

/** Like readConversionMetadata, but a storage read that fails for another reason than a missing object rejects. */
async function inspectConversionMetadata(
  context: ComputeWorkerRouteContext,
  input: typeof documentConversionResolveSchema._output,
): Promise<DocumentConversionArtifactMetadata | null> {
  const key = documentConversionMetadataArtifactKey({
    conversionId: input.conversionId,
    namespace: input.namespace,
    prefix: context.s3Prefix,
  });
  try {
    const parsed = JSON.parse(Buffer.from(await context.storage.readObject(key)).toString('utf8')) as DocumentConversionArtifactMetadata;
    if (
      parsed.schemaVersion !== 1
      || parsed.conversionId !== input.conversionId
      || parsed.namespace !== input.namespace
      || parsed.sourceObjectKey !== input.sourceObjectKey
      || parsed.sourceLastModifiedMs !== input.sourceLastModifiedMs
      || parsed.sourceContentType !== input.sourceContentType
      || parsed.sourceEtag !== (input.sourceEtag ?? null)
      || parsed.status !== 'ready'
    ) return null;
    return await context.storage.objectExists(parsed.objectKey) ? parsed : null;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Whether an artifact is present, where a storage error counts as present: only a confirmed absence replaces an operation. */
function presentUnlessMissing(exists: Promise<boolean>): Promise<boolean> {
  return exists.catch(() => true);
}

async function readIndexedOperation(context: ComputeWorkerRouteContext, opKey: string) {
  const index = await context.deps.operationStateStore.getOpIndex?.(opKey);
  return index?.opId ? await context.deps.operationStateStore.getOpState(index.opId) : null;
}

/**
 * A succeeded operation whose artifact was removed since (by orphan cleanup or
 * expiry) no longer describes the document: resolve does not report it, and
 * the next job replaces it instead of reusing it. Read the operation before
 * the artifact, because an operation only succeeds once its artifact is
 * published, so a missing artifact after that read was removed.
 */
function describesArtifact(operation: { status: string } | null, hasArtifact: boolean): boolean {
  return operation?.status !== 'succeeded' || hasArtifact;
}

/** The indexed operation a new job replaces because its artifact is gone. */
async function operationWithoutArtifact(
  context: ComputeWorkerRouteContext,
  opKey: string,
  hasArtifact: () => Promise<boolean>,
): Promise<string | undefined> {
  const operation = await readIndexedOperation(context, opKey);
  if (!operation || describesArtifact(operation, await hasArtifact())) return undefined;
  return operation.opId;
}

function pdfLayoutExists(context: ComputeWorkerRouteContext, input: { documentId: string; namespace: string | null }) {
  const artifactKey = parsedPdfArtifactKey({ ...input, prefix: context.s3Prefix });
  return context.deps.artifactExists?.(artifactKey) ?? Promise.resolve(false);
}

function logAccepted(context: ComputeWorkerRouteContext, requestOp: WorkerOperationRequest, op: Awaited<ReturnType<ComputeWorkerRouteContext['deps']['orchestrator']['enqueueOrReuse']>>): void {
  context.app.log.info({
    kind: requestOp.kind,
    opId: op.opId,
    jobId: op.jobId,
    status: op.status,
    opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
  }, 'op.accepted');
}

export function registerDocumentJobRoutes(context: ComputeWorkerRouteContext): void {
  const { app, deps, ensureOrphanedOpRecovery } = context;

  app.post('/v1/pdf-layout/jobs', {
    schema: {
      body: jsonSchema(pdfOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = pdfOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const requestOp: WorkerOperationRequest = {
      kind: 'pdf_layout',
      opKey: buildPdfOperationKey(parsed.data),
      payload: {
        documentId: parsed.data.documentId,
        namespace: parsed.data.namespace,
        documentObjectKey: parsed.data.documentObjectKey,
      },
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp, {
      replaceOpId: await operationWithoutArtifact(context, requestOp.opKey, () => presentUnlessMissing(
        pdfLayoutExists(context, parsed.data),
      )),
    });
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/document-previews/jobs', {
    schema: {
      body: jsonSchema(documentPreviewOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = documentPreviewOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const requestOp: WorkerOperationRequest = {
      kind: 'document_preview',
      opKey: buildDocumentPreviewOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp, {
      replaceOpId: await operationWithoutArtifact(context, requestOp.opKey, () => presentUnlessMissing(
        inspectDocumentPreviewMetadata(context.storage, parsed.data, context.s3Prefix).then((artifact) => artifact !== null),
      )),
    });
    logAccepted(context, requestOp, op);
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/document-conversions/docx/jobs', {
    schema: {
      body: jsonSchema(documentConversionOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = documentConversionOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const requestOp: WorkerOperationRequest = {
      kind: 'document_conversion',
      opKey: buildDocumentConversionOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp, {
      replaceOpId: await operationWithoutArtifact(context, requestOp.opKey, () => presentUnlessMissing(
        inspectConversionMetadata(context, parsed.data).then((artifact) => artifact !== null),
      )),
    });
    logAccepted(context, requestOp, op);
    reply.code(202);
    return toComputeOperation(op);
  });
}

export function registerDocumentResolutionRoutes(context: ComputeWorkerRouteContext): void {
  const { app, ensureOrphanedOpRecovery, s3Prefix } = context;

  app.post('/v1/pdf-layout/resolve', {
    schema: {
      body: jsonSchema(pdfResolveSchema),
      response: { 200: jsonSchema(pdfLayoutResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = pdfResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const operation = await readIndexedOperation(context, buildPdfOperationKey(parsed.data));
    const hasArtifact = await pdfLayoutExists(context, parsed.data);
    return {
      artifact: hasArtifact ? { objectKey: parsedPdfArtifactKey({ ...parsed.data, prefix: s3Prefix }) } : null,
      operation: operation && describesArtifact(operation, hasArtifact) ? toComputeOperation(operation) : null,
    };
  });

  app.post('/v1/document-previews/resolve', {
    schema: {
      body: jsonSchema(documentPreviewResolveSchema),
      response: { 200: jsonSchema(documentPreviewResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = documentPreviewResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const operation = await readIndexedOperation(context, buildDocumentPreviewOperationKey(parsed.data));
    const artifact = await readDocumentPreviewMetadata(context.storage, parsed.data, context.s3Prefix);
    return { artifact, operation: operation && describesArtifact(operation, artifact !== null) ? toComputeOperation(operation) : null };
  });

  app.post('/v1/document-conversions/docx/resolve', {
    schema: {
      body: jsonSchema(documentConversionResolveSchema),
      response: { 200: jsonSchema(documentConversionResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = documentConversionResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const operation = await readIndexedOperation(context, buildDocumentConversionOperationKey(parsed.data));
    const artifact = await readConversionMetadata(context, parsed.data);
    return { artifact, operation: operation && describesArtifact(operation, artifact !== null) ? toComputeOperation(operation) : null };
  });

}
