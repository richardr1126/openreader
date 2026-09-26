import type { Consumer, JsMsg } from '@nats-io/jetstream';
import { describe, expect, test, vi } from 'vitest';
import { cloneComputeLimitPolicyDocument } from '@openreader/runtime-config/compute-limits';
import type { PdfLayoutProgress } from '../../src/operations/contracts';
import { createJsonCodec } from '../../src/infrastructure/json-codec';
import type { JobHandlers } from '../../src/jobs/handlers';
import {
  createWorkerLoopController,
  type QueuedJob,
  type WorkerLoopOrchestrator,
} from '../../src/jobs/worker-loop';

function createMessage<T>(job: QueuedJob<T>, deliveryCount = 1) {
  const codec = createJsonCodec<QueuedJob<T>>();
  const ack = vi.fn();
  const nak = vi.fn();
  const term = vi.fn();
  const working = vi.fn();
  return {
    codec,
    msg: {
      data: codec.encode(job),
      info: { deliveryCount },
      ack,
      nak,
      term,
      working,
    } as unknown as JsMsg,
    ack,
    nak,
    term,
    working,
  };
}

function createConsumer(message?: JsMsg): Consumer {
  let delivered = false;
  return {
    next: async () => {
      if (!delivered && message) {
        delivered = true;
        return message;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      return null;
    },
  } as unknown as Consumer;
}

function createOrchestrator() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const record = (method: string) => async (input: unknown) => {
    calls.push({ method, input });
    return input;
  };
  const orchestrator: WorkerLoopOrchestrator = {
    markRunning: record('running'),
    markProgress: record('progress'),
    markSucceeded: record('succeeded'),
    markFailed: record('failed'),
  };
  return { orchestrator, calls };
}

describe('worker loop controller', () => {
  test('processes PDF progress, persists success, ACKs, and releases in-flight activity', async () => {
    const owner = {};
    let active = true;
    let inFlight = 0;
    const { orchestrator, calls } = createOrchestrator();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const progress: PdfLayoutProgress = { totalPages: 2, pagesParsed: 1, currentPage: 1, phase: 'infer' };
    const pdf = createMessage({
      jobId: 'job-pdf',
      opId: 'op-pdf',
      opKey: 'pdf-key',
      kind: 'pdf_layout',
      queuedAt: Date.now() - 10,
      payload: {
        documentId: 'a'.repeat(64),
        namespace: null,
        documentObjectKey: 'openreader/doc.pdf',
      },
    });
    const controller = createWorkerLoopController({
      orchestrator,
      handlers: {
        runPdfLayout: async (_payload, _queueWaitMs, hooks) => {
          await hooks?.onProgress?.(progress);
          active = false;
          complete();
          return { parsedObjectKey: 'openreader/parsed.json' };
        },
        runTtsPlayback: async () => ({ sessionId: 'session' }),
        runTtsPlaybackPlan: async () => ({
          planObjectKey: 'plan.json',
          planSignature: 'signature',
          startOrdinal: 0,
          plannedCount: 0,
        }),
        runTtsPlaybackExportArtifact: async () => ({
          artifact: {
            schemaVersion: 1,
            artifactId: 'artifact',
            sessionId: 'session',
            storageUserId: 'storage-user',
            documentId: 'a'.repeat(64),
            documentVersion: 1,
            readerType: 'pdf',
            settingsHash: 'settings',
            planObjectKey: 'plan.json',
            format: 'mp3',
            speed: 1,
            objectKey: 'artifact.mp3',
            contentType: 'audio/mpeg',
            byteLength: 1,
            dispositionFilename: 'artifact.mp3',
            sourceSessionId: 'session',
            sourcePlanObjectKey: 'plan.json',
            status: 'ready',
            createdAt: Date.now(),
          },
        }),
        runDocumentPreview: async () => ({
          artifact: {
            schemaVersion: 1,
            documentId: 'a'.repeat(64),
            namespace: null,
            documentType: 'pdf',
            sourceObjectKey: 'openreader/doc.pdf',
            sourceLastModifiedMs: 1,
            previewKind: 'card',
            rendererVersion: 'test',
            objectKey: 'openreader/preview.jpg',
            metadataObjectKey: 'openreader/preview.json',
            contentType: 'image/jpeg',
            width: 400,
            height: 500,
            byteLength: 1,
            eTag: null,
            status: 'ready',
            createdAt: Date.now(),
          },
        }),
        runDocumentConversion: async () => ({
          artifact: {
            schemaVersion: 1,
            conversionId: 'a'.repeat(64),
            namespace: null,
            sourceObjectKey: 'openreader/upload.docx',
            sourceLastModifiedMs: 1,
            sourceContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sourceEtag: null,
            converterVersion: 'test',
            objectKey: 'openreader/converted.pdf',
            metadataObjectKey: 'openreader/converted.json',
            contentType: 'application/pdf',
            byteLength: 1,
            documentId: 'a'.repeat(64),
            status: 'ready',
            createdAt: Date.now(),
          },
        }),
        runAccountExport: async () => ({
          artifact: {
            schemaVersion: 1,
            artifactId: 'artifact',
            userId: 'user',
            storageUserId: 'storage-user',
            namespace: null,
            exportSchemaVersion: 4,
            manifestHash: 'a'.repeat(64),
            manifestObjectKey: 'openreader/account-export/manifest.json',
            objectKey: 'openreader/account-export/artifact.zip',
            contentType: 'application/zip',
            byteLength: 1,
            dispositionFilename: 'openreader-data.zip',
            status: 'ready',
            createdAt: Date.now(),
          },
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getComputePolicy: cloneComputeLimitPolicyDocument,
      pdfAttempts: 2,
      pdfCodec: pdf.codec,
      isOwnerActive: () => active,
      isStopping: () => false,
      markActivity: vi.fn(),
      onInFlightJobsChanged: (delta) => { inFlight += delta; },
    });

    controller.start(owner, { pdfLayout: createConsumer(pdf.msg) });
    await completed;
    await controller.stop();

    expect(pdf.working).toHaveBeenCalledOnce();
    expect(pdf.ack).toHaveBeenCalledOnce();
    expect(pdf.nak).not.toHaveBeenCalled();
    expect(inFlight).toBe(0);
    expect(calls.map((call) => call.method)).toContain('progress');
    expect(calls.map((call) => call.method)).toContain('succeeded');
  });

  test('NAKs a retryable PDF failure and does not mark it terminal', async () => {
    const owner = {};
    let active = true;
    const { orchestrator, calls } = createOrchestrator();
    let attempted!: () => void;
    const attemptCompleted = new Promise<void>((resolve) => { attempted = resolve; });
    const pdf = createMessage({
      jobId: 'job-pdf',
      opId: 'op-pdf',
      opKey: 'pdf-key',
      kind: 'pdf_layout',
      queuedAt: Date.now(),
      payload: {
        documentId: 'a'.repeat(64),
        namespace: null,
        documentObjectKey: 'openreader/doc.pdf',
      },
    });
    const controller = createWorkerLoopController({
      orchestrator,
      handlers: {
        runPdfLayout: async () => {
          active = false;
          attempted();
          throw new Error('retry me');
        },
        runTtsPlayback: async () => ({ sessionId: 'session' }),
        runTtsPlaybackPlan: async () => ({
          planObjectKey: 'plan.json',
          planSignature: 'signature',
          startOrdinal: 0,
          plannedCount: 0,
        }),
        runTtsPlaybackExportArtifact: async () => ({
          artifact: {
            schemaVersion: 1,
            artifactId: 'artifact',
            sessionId: 'session',
            storageUserId: 'storage-user',
            documentId: 'a'.repeat(64),
            documentVersion: 1,
            readerType: 'pdf',
            settingsHash: 'settings',
            planObjectKey: 'plan.json',
            format: 'mp3',
            speed: 1,
            objectKey: 'artifact.mp3',
            contentType: 'audio/mpeg',
            byteLength: 1,
            dispositionFilename: 'artifact.mp3',
            sourceSessionId: 'session',
            sourcePlanObjectKey: 'plan.json',
            status: 'ready',
            createdAt: Date.now(),
          },
        }),
        runDocumentPreview: async () => ({
          artifact: {
            schemaVersion: 1,
            documentId: 'a'.repeat(64),
            namespace: null,
            documentType: 'pdf',
            sourceObjectKey: 'openreader/doc.pdf',
            sourceLastModifiedMs: 1,
            previewKind: 'card',
            rendererVersion: 'test',
            objectKey: 'openreader/preview.jpg',
            metadataObjectKey: 'openreader/preview.json',
            contentType: 'image/jpeg',
            width: 400,
            height: 500,
            byteLength: 1,
            eTag: null,
            status: 'ready',
            createdAt: Date.now(),
          },
        }),
        runDocumentConversion: async () => ({
          artifact: {
            schemaVersion: 1,
            conversionId: 'a'.repeat(64),
            namespace: null,
            sourceObjectKey: 'openreader/upload.docx',
            sourceLastModifiedMs: 1,
            sourceContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sourceEtag: null,
            converterVersion: 'test',
            objectKey: 'openreader/converted.pdf',
            metadataObjectKey: 'openreader/converted.json',
            contentType: 'application/pdf',
            byteLength: 1,
            documentId: 'a'.repeat(64),
            status: 'ready',
            createdAt: Date.now(),
          },
        }),
        runAccountExport: async () => ({
          artifact: {
            schemaVersion: 1,
            artifactId: 'artifact',
            userId: 'user',
            storageUserId: 'storage-user',
            namespace: null,
            exportSchemaVersion: 4,
            manifestHash: 'a'.repeat(64),
            manifestObjectKey: 'openreader/account-export/manifest.json',
            objectKey: 'openreader/account-export/artifact.zip',
            contentType: 'application/zip',
            byteLength: 1,
            dispositionFilename: 'openreader-data.zip',
            status: 'ready',
            createdAt: Date.now(),
          },
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getComputePolicy: cloneComputeLimitPolicyDocument,
      pdfAttempts: 2,
      pdfCodec: pdf.codec,
      isOwnerActive: () => active,
      isStopping: () => false,
      markActivity: vi.fn(),
      onInFlightJobsChanged: vi.fn(),
    });

    controller.start(owner, { pdfLayout: createConsumer(pdf.msg) });
    await attemptCompleted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.stop();

    expect(pdf.nak).toHaveBeenCalledOnce();
    expect(pdf.term).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).not.toContain('failed');
  });

  test('terminalizes work whose local scheduler wait expires', async () => {
    const owner = {};
    let active = true;
    let unblockFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { unblockFirst = resolve; });
    let firstCompleted!: () => void;
    const firstCompletion = new Promise<void>((resolve) => { firstCompleted = resolve; });
    let expiredCompleted!: () => void;
    const expiredCompletion = new Promise<void>((resolve) => { expiredCompleted = resolve; });
    const first = createMessage({
      jobId: 'job-first', opId: 'op-first', opKey: 'key-first', kind: 'pdf_layout',
      queuedAt: Date.now(),
      payload: {
        documentId: 'a'.repeat(64), namespace: null, documentObjectKey: 'openreader/first.pdf',
      },
    });
    const expired = createMessage({
      jobId: 'job-expired', opId: 'op-expired', opKey: 'key-expired', kind: 'pdf_layout',
      queuedAt: Date.now(),
      payload: {
        documentId: 'b'.repeat(64), namespace: null, documentObjectKey: 'openreader/expired.pdf',
      },
    });
    const messages = [first.msg, expired.msg];
    let nextMessage = 0;
    const consumer = {
      next: async () => {
        const message = messages[nextMessage];
        nextMessage += 1;
        if (message) return message;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return null;
      },
    } as unknown as Consumer;
    const policy = cloneComputeLimitPolicyDocument();
    policy.worker.maxExecutingPerWorker = 2;
    policy.worker.resources.cpu_heavy = 2;
    policy.actions.pdf_layout.execution!.maxConcurrentPerWorker = 1;
    policy.actions.pdf_layout.execution!.maxQueueAgeSeconds = 0.01;
    const { orchestrator, calls } = createOrchestrator();
    const handlers = {
      runPdfLayout: async () => {
        await firstGate;
        active = false;
        firstCompleted();
        return { parsedObjectKey: 'openreader/first.json' };
      },
    } as unknown as JobHandlers;
    const controller = createWorkerLoopController({
      orchestrator,
      handlers,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getComputePolicy: () => policy,
      pdfAttempts: 2,
      pdfCodec: first.codec,
      isOwnerActive: () => active,
      isStopping: () => false,
      markActivity: vi.fn(),
      onInFlightJobsChanged: vi.fn(),
      onOperationTerminal: async ({ operationId }) => {
        if (operationId === 'op-expired') expiredCompleted();
      },
    });

    controller.start(owner, { pdfLayout: consumer });
    await expiredCompletion;
    unblockFirst();
    await firstCompletion;
    await controller.stop();

    expect(expired.term).toHaveBeenCalledOnce();
    expect(expired.nak).not.toHaveBeenCalled();
    expect(expired.ack).not.toHaveBeenCalled();
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'failed',
      input: expect.objectContaining({
        opId: 'op-expired',
        error: expect.objectContaining({ code: 'COMPUTE_QUEUE_AGE_EXCEEDED' }),
      }),
    }));
  });

  test('keeps live playback flowing while whole-document exports queue on their own consumer', async () => {
    const owner = {};
    const playbackJob = (id: string, generationExtent?: 'document') => createMessage({
      jobId: `job-${id}`, opId: `op-${id}`, opKey: `key-${id}`, kind: 'tts_playback',
      queuedAt: Date.now(),
      payload: { sessionId: `session-${id}`, ...(generationExtent ? { generationExtent } : {}) },
    });
    const exportA = playbackJob('export-a', 'document');
    const exportB = playbackJob('export-b', 'document');
    const live = playbackJob('live');
    const queueConsumer = (messages: JsMsg[], pulls: { count: number }) => ({
      next: async () => {
        const message = messages[pulls.count];
        if (message) {
          pulls.count += 1;
          return message;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
        return null;
      },
    } as unknown as Consumer);
    const documentPulls = { count: 0 };
    const policy = cloneComputeLimitPolicyDocument();
    policy.worker.maxExecutingPerWorker = 3;
    let releaseExportA!: () => void;
    const exportAGate = new Promise<void>((resolve) => { releaseExportA = resolve; });
    let liveRan!: () => void;
    const liveCompletion = new Promise<void>((resolve) => { liveRan = resolve; });
    const started: string[] = [];
    const handlers = {
      runTtsPlayback: async (payload: { sessionId: string }) => {
        started.push(payload.sessionId);
        if (payload.sessionId === 'session-export-a') await exportAGate;
        if (payload.sessionId === 'session-live') liveRan();
        return { sessionId: payload.sessionId };
      },
    } as unknown as JobHandlers;
    const { orchestrator } = createOrchestrator();
    const controller = createWorkerLoopController({
      orchestrator,
      handlers,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getComputePolicy: () => policy,
      pdfAttempts: 1,
      pdfCodec: exportA.codec as never,
      ttsPlaybackCodec: exportA.codec as never,
      isOwnerActive: () => true,
      isStopping: () => false,
      markActivity: vi.fn(),
      onInFlightJobsChanged: vi.fn(),
    });

    controller.start(owner, {
      pdfLayout: createConsumer(),
      ttsPlayback: queueConsumer([live.msg], { count: 0 }),
      ttsPlaybackDocument: queueConsumer([exportA.msg, exportB.msg], documentPulls),
    });
    await liveCompletion;
    // One document slot per worker: export B stays in JetStream for any
    // replica instead of waiting inside this worker.
    await vi.waitFor(() => expect(started).toContain('session-export-a'));
    expect(started).not.toContain('session-export-b');
    expect(documentPulls.count).toBe(1);

    releaseExportA();
    await vi.waitFor(() => expect(exportB.ack).toHaveBeenCalledOnce());
    expect(started.at(-1)).toBe('session-export-b');
    await controller.stop();
  });

  test('fails queued playback work that a stopping worker cannot redeliver', async () => {
    const job = (id: string) => createMessage({
      jobId: `job-${id}`, opId: `op-${id}`, opKey: `key-${id}`, kind: 'tts_playback',
      queuedAt: Date.now(),
      payload: { sessionId: `session-${id}` },
    });
    const running = job('running');
    const queued = job('queued');
    const messages = [running.msg, queued.msg];
    let nextMessage = 0;
    const consumer = {
      next: async () => {
        const message = messages[nextMessage];
        nextMessage += 1;
        if (message) return message;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return null;
      },
    } as unknown as Consumer;
    const policy = cloneComputeLimitPolicyDocument();
    policy.worker.maxExecutingPerWorker = 2;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const runningStarted = new Promise<void>((resolve) => { started = resolve; });
    const { orchestrator, calls } = createOrchestrator();
    const controller = createWorkerLoopController({
      orchestrator,
      handlers: {
        runTtsPlayback: async (payload: { sessionId: string }) => {
          started();
          await gate;
          return { sessionId: payload.sessionId };
        },
      } as unknown as JobHandlers,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getComputePolicy: () => policy,
      pdfAttempts: 1,
      pdfCodec: running.codec as never,
      ttsPlaybackCodec: running.codec as never,
      isOwnerActive: () => true,
      isStopping: () => false,
      markActivity: vi.fn(),
      onInFlightJobsChanged: vi.fn(),
    });

    controller.start({}, { pdfLayout: createConsumer(), ttsPlayback: consumer });
    await runningStarted;
    await vi.waitFor(() => expect(nextMessage).toBeGreaterThanOrEqual(2));
    const stopping = controller.stop();
    release();
    await stopping;

    expect(queued.term).toHaveBeenCalledOnce();
    expect(queued.nak).not.toHaveBeenCalled();
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'failed',
      input: expect.objectContaining({
        opId: 'op-queued',
        error: expect.objectContaining({ code: 'COMPUTE_WORK_NOT_STARTED' }),
      }),
    }));
  });
});
