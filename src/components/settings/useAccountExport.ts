'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { parseApiError } from '@/lib/client/api/http';

type AccountExportSnapshot = {
  artifactId: string;
  manifestHash: string;
  schemaVersion: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'ready';
  operationId: string | null;
  progress?: {
    phase?: 'assembling' | 'uploading';
    completedFiles?: number;
    plannedFiles?: number;
  } | null;
  downloadUrl: string | null;
};

export function useAccountExport() {
  const [isExporting, setIsExporting] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  const closeSource = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  useEffect(() => closeSource, [closeSource]);

  const resolveExistingExport = useCallback(async (
    snapshot: Pick<AccountExportSnapshot, 'artifactId' | 'manifestHash' | 'schemaVersion'>,
  ) => {
    const response = await fetch('/api/user/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    if (!response.ok) {
      throw await parseApiError(response, 'Failed to resolve account export');
    }
    return await response.json() as AccountExportSnapshot;
  }, []);

  const downloadWhenReady = useCallback(async (snapshot: AccountExportSnapshot) => {
    const ready = snapshot.downloadUrl ? snapshot : await resolveExistingExport(snapshot);
    if (!ready.downloadUrl) {
      throw new Error('Account export finished without a download URL');
    }
    window.location.href = ready.downloadUrl;
  }, [resolveExistingExport]);

  const startExport = useCallback(async () => {
    if (isExporting) return;

    closeSource();
    setIsExporting(true);
    const toastId = toast.loading('Preparing account export...');

    try {
      const response = await fetch('/api/user/export', { method: 'POST' });
      if (!response.ok) {
        throw await parseApiError(response, 'Failed to export account data');
      }

      const snapshot = await response.json() as AccountExportSnapshot;
      if (snapshot.downloadUrl || snapshot.status === 'ready' || snapshot.status === 'succeeded') {
        await downloadWhenReady(snapshot);
        toast.success('Account export ready.', { id: toastId });
        setIsExporting(false);
        return;
      }
      if (!snapshot.operationId) {
        throw new Error('Account export did not return a worker operation id');
      }

      const operationId = snapshot.operationId;
      const createSource = () => new EventSource(`/api/user/export/events?opId=${encodeURIComponent(operationId)}`);
      let source: EventSource | null = null;
      let recoveryInFlight = false;

      const failExport = (error: unknown) => {
        closeSource();
        setIsExporting(false);
        toast.error(
          error instanceof Error ? error.message : 'Failed to monitor account export',
          { id: toastId },
        );
      };

      const handleSnapshot = (event: Event) => {
        if (!(event instanceof MessageEvent)) return;
        try {
          const payload = JSON.parse(event.data) as {
            snapshot?: {
              status?: 'queued' | 'running' | 'succeeded' | 'failed';
              progress?: AccountExportSnapshot['progress'];
            };
          };
          const status = payload.snapshot?.status;
          const progress = payload.snapshot?.progress;
          if (progress?.plannedFiles && progress.plannedFiles > 0) {
            toast.loading(
              `Preparing account export (${progress.completedFiles ?? 0}/${progress.plannedFiles})...`,
              { id: toastId },
            );
          }
          if (status === 'failed') {
            closeSource();
            setIsExporting(false);
            toast.error('Account export failed.', { id: toastId });
          }
          if (status === 'succeeded') {
            closeSource();
            void downloadWhenReady(snapshot)
              .then(() => toast.success('Account export ready.', { id: toastId }))
              .catch((error) => {
                console.error('Failed to download account export:', error);
                toast.error(
                  error instanceof Error ? error.message : 'Failed to download account export',
                  { id: toastId },
                );
              })
              .finally(() => setIsExporting(false));
          }
        } catch {
          // Ignore malformed frames and keep the event stream alive.
        }
      };

      const registerSource = (nextSource: EventSource) => {
        source = nextSource;
        sourceRef.current = nextSource;
        nextSource.addEventListener('snapshot', handleSnapshot);
        nextSource.addEventListener('error', () => {
          void recoverFromStreamError();
        });
      };

      async function recoverFromStreamError() {
        const recoveringSource = source;
        if (
          recoveryInFlight
          || recoveringSource === null
          || sourceRef.current !== recoveringSource
        ) return;
        recoveryInFlight = true;
        let lastError: unknown = new Error('Lost connection while preparing account export');

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 750));
          if (sourceRef.current !== recoveringSource) return;

          try {
            const refreshed = await resolveExistingExport(snapshot);
            if (sourceRef.current !== recoveringSource) return;
            if (refreshed.status === 'failed') {
              failExport(new Error('Account export failed.'));
              return;
            }
            if (
              refreshed.downloadUrl
              || refreshed.status === 'ready'
              || refreshed.status === 'succeeded'
            ) {
              closeSource();
              try {
                await downloadWhenReady(refreshed);
                toast.success('Account export ready.', { id: toastId });
                setIsExporting(false);
              } catch (error) {
                failExport(error);
              }
              return;
            }

            if (recoveringSource.readyState === EventSource.CLOSED) {
              registerSource(createSource());
            }
            // The operation is still healthy. Let EventSource resume its normal
            // reconnect loop when possible, replacing only a terminally closed
            // source before allowing another recovery attempt.
            recoveryInFlight = false;
            return;
          } catch (error) {
            lastError = error;
          }
        }

        if (sourceRef.current === recoveringSource) {
          failExport(lastError);
        }
      }

      registerSource(createSource());
      // EventSource reconnects with Last-Event-ID. The operation snapshot is
      // the source of truth, so transient transport errors remain non-terminal.
    } catch (error) {
      console.error('Failed to export account data:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to export account data', { id: toastId });
      setIsExporting(false);
    }
  }, [closeSource, downloadWhenReady, isExporting, resolveExistingExport]);

  return { isExporting, startExport };
}
