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
  let cancelled = false;

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
          if (!resolution.operationId) throw new Error('Pending reader bootstrap has no operation');

          const operationId = resolution.operationId;
          const upstream = await getComputeWorkerClient().openOperationEvents(operationId, {
            signal: request.signal,
          });
          if (!upstream.ok || !upstream.body) {
            throw new Error(await upstream.text().catch(() => 'Failed to observe reader bootstrap'));
          }

          activeReader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let advanced = false;
          while (!cancelled) {
            const { done, value } = await activeReader.read();
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
                const changedOperation = resolution.operationId !== operationId;
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
          await activeReader.cancel().catch(() => undefined);
          activeReader = null;
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
        void activeReader?.cancel().catch(() => undefined);
        activeReader = null;
      });
    },
    cancel() {
      cancelled = true;
      void activeReader?.cancel().catch(() => undefined);
      activeReader = null;
    },
  });
}
