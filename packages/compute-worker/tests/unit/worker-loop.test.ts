import type { Consumer, JsMsg } from '@nats-io/jetstream';
import { describe, expect, test, vi } from 'vitest';
import type { PdfLayoutProgress } from '../../src/operations/contracts';
import { createJsonCodec } from '../../src/infrastructure/json-codec';
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
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      jobConcurrency: 1,
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
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      jobConcurrency: 1,
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
});
