'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthSession } from '@/hooks/useAuthSession';
import { queryKeys } from '@/lib/client/query-keys';

type ComponentProgress = { name: string; totalBytes: number; downloadedBytes: number; state: string };
type DownloadProgress = { downloadedBytes: number; totalBytes: number; components?: ComponentProgress[] };
type Operation = {
  opId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error?: { message: string };
  progress?: DownloadProgress;
};
type ModelStatus = {
  components: { name: string; totalBytes: number; installedBytes: number }[];
  downloading: boolean;
  operation: Operation | null;
};

const isActive = (operation: Operation | null | undefined) =>
  operation?.status === 'queued' || operation?.status === 'running';

async function fetchStatus(): Promise<ModelStatus> {
  const res = await fetch('/api/admin/local-voices', { cache: 'no-store' });
  const data = await res.json().catch(() => ({})) as ModelStatus & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function send(method: 'POST' | 'DELETE', path = ''): Promise<{ operation?: Operation }> {
  const res = await fetch(`/api/admin/local-voices${path}`, { method });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({})) as { operation?: Operation; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * Kokoro, the voice model the compute worker runs itself (on desktop, this
 * device): its installed state, and a download followed live over the
 * operation's SSE stream. Admin only. Shared by the Providers card and the
 * desktop onboarding step, which may both be mounted; each follows the same
 * worker operation.
 */
export function useLocalVoices({ enabled = true }: { enabled?: boolean } = {}) {
  const { data: session } = useAuthSession();
  const queryKey = queryKeys.admin(session?.user?.id ?? 'no-session', 'local-voices');
  const queryClient = useQueryClient();
  const { data: status, error, isPending } = useQuery({ queryKey, queryFn: fetchStatus, enabled });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey }), [queryClient, queryKey]);

  const follow = useCallback((next: Operation) => {
    setOperation(next);
    sourceRef.current?.close();
    sourceRef.current = null;
    if (!isActive(next)) return;
    const source = new EventSource(`/api/admin/local-voices/events?opId=${encodeURIComponent(next.opId)}`);
    sourceRef.current = source;
    source.addEventListener('snapshot', (event) => {
      const snapshot = (JSON.parse((event as MessageEvent<string>).data) as { snapshot?: Operation }).snapshot;
      if (!snapshot) return;
      setOperation(snapshot);
      if (isActive(snapshot)) return;
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
      void refresh();
    });
    // EventSource reconnects on its own with Last-Event-ID.
  }, [refresh]);

  useEffect(() => () => sourceRef.current?.close(), []);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const { operation: started } = await send('POST');
      if (started) follow(started);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the download');
    } finally {
      setBusy(false);
    }
  }, [follow]);

  // Pick up a download already under way: the last one started from here, or
  // one playback started (joining it gives it a progress stream).
  useEffect(() => {
    if (!status || sourceRef.current) return;
    if (isActive(status.operation)) follow(status.operation!);
    else if (status.downloading) void start();
    else if (status.operation && !operation) setOperation(status.operation);
  }, [status, operation, follow, start]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      await send('POST', '/cancel');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel the download');
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await send('DELETE');
      setOperation(null);
      toast.success('Kokoro removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove Kokoro');
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [refresh]);

  const components = status?.components ?? [];
  const totalBytes = components.reduce((sum, c) => sum + c.totalBytes, 0);
  const installedBytes = components.reduce((sum, c) => sum + Math.min(c.installedBytes, c.totalBytes), 0);
  const installed = components.length > 0 && installedBytes === totalBytes;
  const downloading = isActive(operation);
  return {
    status,
    error,
    isPending,
    busy,
    totalBytes,
    installedBytes,
    installed,
    downloading,
    progress: downloading ? operation?.progress : undefined,
    failure: !downloading && !installed && operation?.status === 'failed' ? operation.error?.message : undefined,
    start,
    cancel,
    remove,
  };
}
