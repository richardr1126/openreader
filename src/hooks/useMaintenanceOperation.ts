'use client';

import { useEffect, useRef, useState } from 'react';
import type { ComputeOperation, ComputeOperationEvent, MaintenanceResult } from '@/lib/server/compute-worker/protocol';

export type MaintenanceOperation = ComputeOperation<MaintenanceResult>;

/** Reconnect to durable snapshots; the worker continues when the panel closes. */
export function useMaintenanceOperation(opId: string | null, onSettled: (operation: MaintenanceOperation) => void, onUnavailable?: () => void) {
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
    const connect = () => {
      if (stopped) return;
      const params = new URLSearchParams({ opId, ...(lastEventId ? { sinceEventId: lastEventId } : {}) });
      source = new EventSource(`/api/admin/maintenance/events?${params}`);
      source.addEventListener('snapshot', (event) => {
        try {
          const frame = JSON.parse((event as MessageEvent).data) as ComputeOperationEvent<MaintenanceResult>;
          if (frame.snapshot.opId !== opId || frame.snapshot.subject.kind !== 'maintenance') return;
          lastEventId = (event as MessageEvent).lastEventId;
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
        callback.current.onUnavailable?.();
      });
      source.addEventListener('error', () => {
        if (stopped) return;
        setReconnecting(true);
        if (source?.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2_000);
      });
    };
    connect();
    return () => { stopped = true; source?.close(); clearTimeout(retry); };
  }, [opId]);
  const current = operation?.opId === opId ? operation : null;
  const progress = current?.progress && 'completed' in current.progress ? current.progress : null;
  return { operation: current, progress, reconnecting };
}
