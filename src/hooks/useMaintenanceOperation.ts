'use client';

import { useEffect, useRef, useState } from 'react';
import type { ComputeOperation, ComputeOperationEvent, MaintenanceResult } from '@/lib/server/compute-worker/protocol';

export type MaintenanceOperation = ComputeOperation<MaintenanceResult>;
/** `expired`: the worker no longer has the operation. `disconnected`: the stream kept failing. */
export type MaintenanceUnavailableReason = 'expired' | 'disconnected';

// The error event hides the HTTP status, so a rejected stream (401/403) and a
// transient 502 look alike; a bounded run of failures covers both.
const MAX_CONSECUTIVE_RECONNECTS = 5;

/** Reconnect to durable snapshots; the worker continues when the panel closes. */
export function useMaintenanceOperation(opId: string | null, onSettled: (operation: MaintenanceOperation) => void, onUnavailable?: (reason: MaintenanceUnavailableReason) => void) {
  const [operation, setOperation] = useState<MaintenanceOperation | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const callback = useRef({ onSettled, onUnavailable });
  useEffect(() => { callback.current = { onSettled, onUnavailable }; });
  useEffect(() => {
    if (!opId) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let lastEventId = '';
    let failures = 0;
    const connect = () => {
      if (stopped) return;
      const params = new URLSearchParams({ opId, ...(lastEventId ? { sinceEventId: lastEventId } : {}) });
      source = new EventSource(`/api/admin/maintenance/events?${params}`);
      source.addEventListener('snapshot', (event) => {
        try {
          const frame = JSON.parse((event as MessageEvent).data) as ComputeOperationEvent<MaintenanceResult>;
          if (frame.snapshot.opId !== opId || frame.snapshot.subject.kind !== 'maintenance') return;
          lastEventId = (event as MessageEvent).lastEventId;
          failures = 0;
          setOperation(frame.snapshot);
          setReconnecting(false);
          if (frame.snapshot.status === 'succeeded' || frame.snapshot.status === 'failed') {
            stopped = true;
            source?.close();
            callback.current.onSettled(frame.snapshot);
          }
        } catch { /* A malformed frame must not replace the last valid state. */ }
      });
      source.addEventListener('unavailable', () => {
        stopped = true;
        source?.close();
        callback.current.onUnavailable?.('expired');
      });
      source.addEventListener('error', () => {
        if (stopped) return;
        setReconnecting(true);
        if (source?.readyState !== EventSource.CLOSED) return;
        if (++failures > MAX_CONSECUTIVE_RECONNECTS) {
          stopped = true;
          setReconnecting(false);
          callback.current.onUnavailable?.('disconnected');
          return;
        }
        retry = setTimeout(connect, 2_000);
      });
    };
    connect();
    return () => { stopped = true; source?.close(); clearTimeout(retry); };
  }, [opId]);
  const current = operation?.opId === opId ? operation : null;
  const progress = current?.progress && 'completed' in current.progress ? current.progress : null;
  return { operation: current, progress, reconnecting };
}
