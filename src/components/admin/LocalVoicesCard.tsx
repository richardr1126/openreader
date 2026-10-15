'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Badge, Button } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { queryKeys } from '@/lib/client/query-keys';
import { formatBytes } from '@/lib/shared/format-bytes';

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
 * device). It downloads on first use; this card fetches it ahead of time, shows
 * the download live over the operation's SSE stream, and removes it again.
 */
export function LocalVoicesCard() {
  const onDevice = useRuntimeConfig().installProfile === 'desktop';
  const { data: session } = useAuthSession();
  const queryKey = queryKeys.admin(session?.user?.id ?? 'no-session', 'local-voices');
  const queryClient = useQueryClient();
  const { data: status, error, isPending } = useQuery({ queryKey, queryFn: fetchStatus });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
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

  // Pick up a download already under way: the last one this card started, or
  // one playback started (joining it gives it a progress stream).
  useEffect(() => {
    if (!status || sourceRef.current) return;
    if (isActive(status.operation)) follow(status.operation!);
    else if (status.downloading) void start();
    else if (status.operation && !operation) setOperation(status.operation);
  }, [status, operation, follow, start]);

  const cancel = async () => {
    setBusy(true);
    try {
      await send('POST', '/cancel');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel the download');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
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
  };

  const where = onDevice ? 'on this device' : 'on the compute worker';
  const components = status?.components ?? [];
  const totalBytes = components.reduce((sum, c) => sum + c.totalBytes, 0);
  const installedBytes = components.reduce((sum, c) => sum + Math.min(c.installedBytes, c.totalBytes), 0);
  const installed = components.length > 0 && installedBytes === totalBytes;
  const downloading = isActive(operation);
  const progress = downloading ? operation?.progress : undefined;
  const failed = !downloading && !installed && operation?.status === 'failed' ? operation.error?.message : undefined;

  let state: string;
  if (isPending) state = 'Checking…';
  else if (error) state = error.message;
  else if (downloading) {
    state = progress
      ? `Downloading · ${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}`
      : 'Starting the download…';
  } else if (installed) state = `Downloaded · ${formatBytes(totalBytes)}`;
  else if (installedBytes > 0) state = `Partly downloaded · ${formatBytes(installedBytes)} of ${formatBytes(totalBytes)}`;
  else state = `Not downloaded · about ${formatBytes(totalBytes)}`;

  const percent = progress && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
    : 0;

  return (
    <section aria-labelledby="local-voices-title" className="rounded-lg border border-line-soft bg-surface-solid px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 id="local-voices-title" className="text-sm font-medium text-foreground">Kokoro {where}</h3>
            {installed && !downloading && <Badge tone="accent">Ready</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-soft">
            {onDevice
              ? 'Voices that run on this device with no account or key. They download the first time they speak, or now.'
              : 'Voices the compute worker runs itself with no key. Each worker replica keeps its own copy, downloaded the first time it speaks, or now.'}
          </p>
          <p className="mt-1.5 text-sm text-muted" aria-live="polite">{state}</p>
          {failed && <p className="mt-1 text-sm text-danger">{failed}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {downloading ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
          ) : installed ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</Button>
          ) : (
            <Button size="sm" disabled={busy || isPending || Boolean(error)} onClick={() => void start()}>
              {failed || installedBytes > 0 ? 'Resume download' : 'Download'}
            </Button>
          )}
        </div>
      </div>
      {downloading && (
        <div className="mt-3 space-y-2">
          <div
            role="progressbar"
            aria-label="Kokoro download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-line-soft"
          >
            <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          {progress?.components && (
            <ul className="space-y-0.5 text-xs text-soft">
              {progress.components.map((c) => (
                <li key={c.name} className="flex justify-between gap-3">
                  <span>{c.name}</span>
                  <span className="tabular-nums">
                    {c.state === 'ready' ? 'Done' : c.state === 'verifying' ? 'Verifying…' : `${formatBytes(c.downloadedBytes)} of ${formatBytes(c.totalBytes)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => void remove()}
        title="Remove Kokoro?"
        message={`This deletes ${formatBytes(totalBytes)} of voice data ${where}. Kokoro voices download it again the next time they speak.`}
        confirmText="Remove"
        isDangerous
      />
    </section>
  );
}
