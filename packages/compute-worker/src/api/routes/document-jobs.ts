import { hashOpKey } from '../../infrastructure/nats-adapters';
import type { WorkerOperationRequest } from '../../operations/contracts';
import {
  buildDocumentConversionOperationKey,
  buildDocumentPreviewOperationKey,
  buildPdfOperationKey,
} from '../../operations/keys';
import {
  documentConversionMetadataArtifactKey,
  documentPreviewMetadataArtifactKey,
  parsedPdfArtifactKey,
} from '../../storage/artifact-addressing';
import type {
  DocumentConversionArtifactMetadata,
  DocumentPreviewArtifactMetadata,
} from '../../operations/contracts';
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

async function readPreviewMetadata(
  context: ComputeWorkerRouteContext,
  input: typeof documentPreviewResolveSchema._output,
): Promise<DocumentPreviewArtifactMetadata | null> {
  const key = documentPreviewMetadataArtifactKey({
    documentId: input.documentId,
    namespace: input.namespace,
    prefix: context.s3Prefix,
  });
  try {
    const parsed = JSON.parse(Buffer.from(await context.storage.readObject(key)).toString('utf8')) as DocumentPreviewArtifactMetadata;
    if (
      parsed.schemaVersion !== 1
      || parsed.documentId !== input.documentId
      || parsed.namespace !== input.namespace
      || parsed.documentType !== input.documentType
      || parsed.sourceObjectKey !== input.sourceObjectKey
      || parsed.sourceLastModifiedMs !== input.sourceLastModifiedMs
      || parsed.previewKind !== input.previewKind
      || parsed.status !== 'ready'
    ) return null;
    return await context.storage.objectExists(parsed.objectKey).catch(() => false) ? parsed : null;
  } catch {
    return null;
  }
}

async function readConversionMetadata(
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
    return await context.storage.objectExists(parsed.objectKey).catch(() => false) ? parsed : null;
  } catch {
    return null;
  }
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
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
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
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
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
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    logAccepted(context, requestOp, op);
    reply.code(202);
    return toComputeOperation(op);
  });
}

export function registerDocumentResolutionRoutes(context: ComputeWorkerRouteContext): void {
  const { app, deps, ensureOrphanedOpRecovery, s3Prefix } = context;

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
    const artifactKey = parsedPdfArtifactKey({
      documentId: parsed.data.documentId,
      namespace: parsed.data.namespace,
      prefix: s3Prefix,
    });
    const hasArtifact = await deps.artifactExists?.(artifactKey) ?? false;
    const index = await deps.operationStateStore.getOpIndex?.(buildPdfOperationKey(parsed.data));
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return {
      artifact: hasArtifact ? { objectKey: artifactKey } : null,
      operation: operation ? toComputeOperation(operation) : null,
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
    const artifact = await readPreviewMetadata(context, parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(buildDocumentPreviewOperationKey(parsed.data));
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return { artifact, operation: operation ? toComputeOperation(operation) : null };
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
    const artifact = await readConversionMetadata(context, parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(buildDocumentConversionOperationKey(parsed.data));
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return { artifact, operation: operation ? toComputeOperation(operation) : null };
  });
}
