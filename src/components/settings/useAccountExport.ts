'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

type AccountExportSnapshot = {
  artifactId: string;
  manifestHash: string;
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
    snapshot: Pick<AccountExportSnapshot, 'artifactId' | 'manifestHash'>,
  ) => {
    const response = await fetch('/api/user/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `Account export resolve failed with status ${response.status}`);
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
        const detail = await response.text().catch(() => '');
        throw new Error(detail || `Account export failed with status ${response.status}`);
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

      const source = new EventSource(`/api/user/export/events?opId=${encodeURIComponent(snapshot.operationId)}`);
      sourceRef.current = source;
      source.addEventListener('snapshot', (event) => {
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
      });
      source.addEventListener('error', () => {
        closeSource();
        setIsExporting(false);
        toast.error('Account export progress disconnected.', { id: toastId });
      });
    } catch (error) {
      console.error('Failed to export account data:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to export account data', { id: toastId });
      setIsExporting(false);
    }
  }, [closeSource, downloadWhenReady, isExporting]);

  return { isExporting, startExport };
}
