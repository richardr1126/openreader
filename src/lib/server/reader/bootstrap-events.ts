import type { NextRequest } from 'next/server';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import type { ComputeOperation, PdfLayoutResult } from '@/lib/server/compute-worker/protocol';
import { resolvePdfOperationReadiness } from './bootstrap-progress';
import {
  resolveReaderBootstrapState,
  type ReaderBootstrapResolveOptions,
  type ReaderBootstrapResolution,
} from '@/lib/server/reader/bootstrap';

const encoder = new TextEncoder();

/**
 * A running compute operation rewrites its state every few seconds, so its
 * event stream reports at least that often. Longer silence than the worker's
 * own liveness window means nothing is working on the operation: the stream
 * will never report again, and only a fresh resolve can say so. Comfortably
 * above that window so the worker, not this reader, decides liveness.
 */
const OPERATION_SILENCE_LIMIT_MS = 45_000;

/** The operation a pending resolution is waiting on, which its stream follows. */
function pendingOperationId(resolution: ReaderBootstrapResolution): string | undefined {
  return resolution.result.status === 'pending' ? resolution.result.operationId : undefined;
}

function frame(result: ReaderBootstrapResolution['result']): Uint8Array {
  return encoder.encode(`event: snapshot\ndata: ${JSON.stringify(result)}\n\n`);
}

function readWorkerSnapshot(value: string): ComputeOperation<PdfLayoutResult> | null {
  try {
    const data = value.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    const snapshot = JSON.parse(data)?.snapshot;
    return snapshot && typeof snapshot.opId === 'string'
      && ['queued', 'running', 'succeeded', 'failed'].includes(snapshot.status)
      ? snapshot : null;
  } catch {
    return null;
  }
}

export function createReaderBootstrapEventStream(
  request: NextRequest,
  documentId: string,
  initial: ReaderBootstrapResolution,
  resolveOptions: ReaderBootstrapResolveOptions = {},
): ReadableStream<Uint8Array> {
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const stopSilenceTimer = (): void => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let resolution = initial;
        let signature = '';

        while (!cancelled) {
          const nextSignature = JSON.stringify(resolution.result);
          if (nextSignature !== signature) {
            controller.enqueue(frame(resolution.result));
            signature = nextSignature;
          }
          if (resolution.result.status !== 'pending') break;
          const operationId = pendingOperationId(resolution);
          if (!operationId) throw new Error('Pending reader bootstrap has no operation');
          const upstream = await getComputeWorkerClient().openOperationEvents(operationId, {
            signal: request.signal,
          });
          if (!upstream.ok || !upstream.body) {
            throw new Error(await upstream.text().catch(() => 'Failed to observe reader bootstrap'));
          }

          const reader = upstream.body.getReader();
          activeReader = reader;
          const decoder = new TextDecoder();
          let buffer = '';
          let advanced = false;
          let silent = false;
          // Ending the read is what wakes this loop back up; a pending read
          // cannot be raced away without leaking it.
          const heard = (): void => {
            stopSilenceTimer();
            silenceTimer = setTimeout(() => {
              silent = true;
              void reader.cancel().catch(() => undefined);
            }, OPERATION_SILENCE_LIMIT_MS);
          };
          heard();
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replaceAll('\r\n', '\n');
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const upstreamFrame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (upstreamFrame.startsWith(':')) {
                controller.enqueue(encoder.encode(`${upstreamFrame}\n\n`));
              }
              if (/^event:\s*snapshot\s*$/m.test(upstreamFrame)) {
                const snapshot = readWorkerSnapshot(upstreamFrame);
                if (!snapshot || snapshot.opId !== operationId) {
                  boundary = buffer.indexOf('\n\n');
                  continue;
                }
                heard();
                if (snapshot.status === 'queued' || snapshot.status === 'running') {
                  // The stream was authorized at entry. Progress is already in
                  // this snapshot: do not turn every download checkpoint into
                  // another database + worker round trip.
                  if (resolution.result.status === 'pending'
                    && resolution.result.progress?.kind === 'pdf-parse') {
                    const progress = resolvePdfOperationReadiness(snapshot);
                    if (progress) {
                      resolution = progress;
                      const updateSignature = JSON.stringify(resolution.result);
                      if (updateSignature !== signature) {
                        controller.enqueue(frame(resolution.result));
                        signature = updateSignature;
                      }
                    }
                  }
                  boundary = buffer.indexOf('\n\n');
                  continue;
                }
                // Only an operation boundary needs full readiness/auth checks
                // and possibly a switch from PDF preparation to plan creation.
                const next = await resolveReaderBootstrapState(
                  request,
                  documentId,
                  resolveOptions,
                );
                if (next instanceof Response) throw new Error('Reader bootstrap authorization changed');
                resolution = next;
                const changedOperation = pendingOperationId(resolution) !== operationId;
                if (resolution.result.status !== 'pending' || changedOperation) {
                  advanced = true;
                  break;
                }
                const updateSignature = JSON.stringify(resolution.result);
                if (updateSignature !== signature) {
                  controller.enqueue(frame(resolution.result));
                  signature = updateSignature;
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
            if (advanced) break;
          }
          stopSilenceTimer();
          await reader.cancel().catch(() => undefined);
          activeReader = null;
          if (silent) {
            const next = await resolveReaderBootstrapState(request, documentId, resolveOptions);
            if (next instanceof Response) throw new Error('Reader bootstrap authorization changed');
            // A resolve settles an abandoned operation, so an unchanged pending
            // result means the operation is alive and this stream was merely
            // reopened; either way the outer loop reports what resolve says.
            if (pendingOperationId(next) === operationId && next.result.status === 'pending') break;
            resolution = next;
            continue;
          }
          if (!advanced) break;
        }
        if (!cancelled) controller.close();
      })().catch(() => {
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // The response may already have been aborted by the client.
          }
        }
      }).finally(() => {
        stopSilenceTimer();
        void activeReader?.cancel().catch(() => undefined);
        activeReader = null;
      });
    },
    cancel() {
      cancelled = true;
      stopSilenceTimer();
      void activeReader?.cancel().catch(() => undefined);
      activeReader = null;
    },
  });
}
