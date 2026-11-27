import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { expect, test } from 'vitest';
import { createArtifactStorage } from '../../src/infrastructure/storage';
import {
  computePlaybackPlanSignature,
  readPlaybackPlanLayoutRevision,
  resolveAndPersistTtsPlaybackPlan,
} from '../../src/jobs/playback/plan';
import { ttsPlaybackPlanArtifactKey } from '../../src/storage/artifact-addressing';

const PREFIX = 'openreader';
const DOCUMENT_ID = 'b'.repeat(64);

function memoryS3() {
  const objects = new Map<string, { body: Buffer; metadata: Record<string, string>; etag: string }>();
  let revision = 0;
  const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  const client = {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) {
        const { Key, Body, Metadata, IfMatch, IfNoneMatch } = command.input;
        const current = objects.get(Key!);
        if ((IfNoneMatch === '*' && current) || (IfMatch && current?.etag !== IfMatch)) {
          throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
        }
        objects.set(Key!, { body: Buffer.from(Body as Buffer), metadata: Metadata ?? {}, etag: `"${++revision}"` });
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        const object = objects.get(command.input.Key!);
        if (!object) throw notFound();
        return { ETag: object.etag, Metadata: object.metadata, ContentLength: object.body.byteLength };
      }
      if (command instanceof GetObjectCommand) {
        const object = objects.get(command.input.Key!);
        if (!object) throw notFound();
        return { Body: object.body };
      }
      throw new Error(`unexpected command ${(command as object).constructor.name}`);
    },
  } as unknown as S3Client;
  return createArtifactStorage({ bucket: 'test', prefix: PREFIX, client });
}

function layout(text: string) {
  return {
    schemaVersion: 1,
    documentId: DOCUMENT_ID,
    parserVersion: 'test',
    parsedAt: 0,
    pages: [{
      pageNumber: 1,
      width: 100,
      height: 100,
      blocks: [{ id: 'b1', kind: 'text', text, fragments: [{ page: 1, bbox: [0, 0, 1, 1], text, readingOrder: 0 }] }],
    }],
  };
}

const request = {
  sessionId: `plan:${DOCUMENT_ID}:hash`,
  userId: 'user-1',
  storageUserId: 'user-1',
  documentId: DOCUMENT_ID,
  documentVersion: 1,
  readerType: 'pdf' as const,
  settingsHash: 'hash',
  settingsJson: { voice: 'alloy', providerRef: 'p', providerType: 'openai', ttsModel: 'm', nativeSpeed: 1 },
  planning: { documentSource: { namespace: null, extent: 'document' as const } },
};

test('Force reparse gives narration a plan from the new layout and keeps the old plan', async () => {
  const storage = memoryS3();
  await storage.putParsedPdf(DOCUMENT_ID, null, layout('Edited block text.'), {
    operationId: 'first-parse', expected: null, signal: AbortSignal.timeout(1_000),
  });
  expect(await readPlaybackPlanLayoutRevision(request, storage, PREFIX)).toBeNull();
  const before = await resolveAndPersistTtsPlaybackPlan({ request, storage, s3Prefix: PREFIX });
  expect(before.plannedSegments.map((segment) => segment.text)).toEqual(['Edited block text.']);

  const revision = await storage.getParsedPdfRevision(DOCUMENT_ID, null, AbortSignal.timeout(1_000));
  await storage.putParsedPdf(DOCUMENT_ID, null, layout('Original block text.'), {
    operationId: 'reparse', expected: revision, signal: AbortSignal.timeout(1_000),
  });
  expect(await readPlaybackPlanLayoutRevision(request, storage, PREFIX)).toBe('reparse');
  const after = await resolveAndPersistTtsPlaybackPlan({ request, storage, s3Prefix: PREFIX });
  expect(after.planObjectKey).not.toBe(before.planObjectKey);
  expect(after.plannedSegments.map((segment) => segment.text)).toEqual(['Original block text.']);

  // Sessions and audiobooks holding the old plan still read it.
  const held = await resolveAndPersistTtsPlaybackPlan({
    request: { ...request, planObjectKey: before.planObjectKey }, storage, s3Prefix: PREFIX,
  });
  expect(held.plannedSegments.map((segment) => segment.text)).toEqual(['Edited block text.']);
});

test('a reparse that lands while a plan is derived moves the plan to the new layout identity', async () => {
  const storage = memoryS3();
  await storage.putParsedPdf(DOCUMENT_ID, null, layout('Old layout text.'), {
    operationId: 'first-parse', expected: null, signal: AbortSignal.timeout(1_000),
  });
  const readObject = storage.readObject.bind(storage);
  let reparsed = false;
  storage.readObject = async (key, signal) => {
    const body = await readObject(key, signal);
    if (!reparsed && key.includes('parsed')) {
      reparsed = true;
      const revision = await storage.getParsedPdfRevision(DOCUMENT_ID, null, AbortSignal.timeout(1_000));
      await storage.putParsedPdf(DOCUMENT_ID, null, layout('New layout text.'), {
        operationId: 'reparse', expected: revision, signal: AbortSignal.timeout(1_000),
      });
    }
    return body;
  };
  const plan = await resolveAndPersistTtsPlaybackPlan({ request, storage, s3Prefix: PREFIX });
  expect(reparsed).toBe(true);
  expect(plan.plannedSegments.map((segment) => segment.text)).toEqual(['New layout text.']);
  // Nothing was stored under the first layout's plan identity.
  expect(await storage.objectExists(ttsPlaybackPlanArtifactKey({
    ...request, planSignature: computePlaybackPlanSignature(request, null), prefix: PREFIX,
  }))).toBe(false);
});
