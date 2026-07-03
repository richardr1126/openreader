'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProgressPopup } from '@/components/ProgressPopup';
import { ProgressCard } from '@/components/ProgressCard';
import { DownloadIcon } from '@/components/icons/Icons';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { VoicesControlBase } from '@/components/player/VoicesControlBase';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { getTtsLanguageCompatibilityWarnings } from '@openreader/tts/language';
import { Badge, Button, RangeField, Section, SegmentedControl } from '@/components/ui';
import { subscribeTtsExportArtifactEvents, subscribeTtsExportGenerationEvents } from '@/lib/client/api/tts';

interface AudiobookExportModalProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  documentType: 'epub' | 'pdf' | 'html';
  documentId: string;
}

type ExportStatus = 'idle' | 'generating' | 'ready' | 'downloading' | 'complete';
type ExportFormat = 'mp3' | 'm4b';

const EXPORT_FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4b', label: 'M4B' },
];

function formatSpeed(speed: number): string {
  return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
}

function clampProgress(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

function formatLabel(format: ExportFormat): string {
  return format.toUpperCase();
}

function withDownloadOptions(url: string, speed: number, format: ExportFormat): string {
  const safeSpeed = Math.max(0.5, Math.min(3, Number.isFinite(speed) ? speed : 1));
  const parsed = new URL(url, window.location.href);
  if (Math.abs(safeSpeed - 1) >= 0.01) {
    parsed.searchParams.set('speed', safeSpeed.toFixed(2));
  } else {
    parsed.searchParams.delete('speed');
  }
  parsed.searchParams.set('format', format);
  if (parsed.origin === window.location.origin) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.toString();
}

export function AudiobookExportModal({
  isOpen,
  setIsOpen,
  documentType,
  documentId,
}: AudiobookExportModalProps) {
  const {
    isLoading,
    providerRef,
    providerType,
    ttsModel,
    voiceSpeed,
    audioPlayerSpeed,
  } = useConfig();
  const {
    voice,
    availableVoices,
    documentLanguage,
    setVoiceAndRestart,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    startDocumentAudioExport,
    resolveDocumentAudioExport,
  } = useTTS();
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [completedSegments, setCompletedSegments] = useState(0);
  const [plannedSegments, setPlannedSegments] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('mp3');
  const [localAudioPlayerSpeed, setLocalAudioPlayerSpeed] = useState(audioPlayerSpeed);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const progressCompleteRef = useRef(false);
  const statusRef = useRef<ExportStatus>('idle');
  const hydrateRunIdRef = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    setLocalAudioPlayerSpeed(audioPlayerSpeed);
  }, [audioPlayerSpeed]);

  const providerModelPolicy = useMemo(
    () => resolveTtsProviderModelPolicy({ providerRef, providerType, model: ttsModel }),
    [providerRef, providerType, ttsModel],
  );
  const nativeSpeedSupported = providerModelPolicy.supportsNativeModelSpeed;
  const languageWarnings = useMemo(() => getTtsLanguageCompatibilityWarnings({
    model: ttsModel,
    voice,
    documentLanguage,
  }), [documentLanguage, ttsModel, voice]);

  const isGenerating = status === 'generating';
  const canDownload = (status === 'ready' || status === 'complete') && Boolean(downloadUrl);
  const exportFormatLabel = formatLabel(exportFormat);
  const progressStatusMessage = plannedSegments > 0
    ? `${completedSegments}/${plannedSegments} segments ready`
    : 'Preparing segments';

  const cleanupSubscription = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  const applyProgressSnapshot = useCallback((completed: number, total: number) => {
    const safeTotal = Math.max(0, Math.floor(total));
    const safeCompleted = safeTotal > 0
      ? Math.max(0, Math.min(safeTotal, Math.floor(completed)))
      : 0;
    setPlannedSegments(safeTotal);
    setCompletedSegments(safeCompleted);
    setProgress(clampProgress(safeCompleted, safeTotal));
    if (safeTotal > 0 && safeCompleted >= safeTotal) {
      progressCompleteRef.current = true;
      cleanupSubscription();
      abortControllerRef.current = null;
      setStatus('ready');
      setProgress(100);
    }
  }, [cleanupSubscription]);

  const markReady = useCallback((total?: number | null) => {
    const safeTotal = Math.max(0, Math.floor(total ?? 0));
    if (safeTotal > 0) {
      setPlannedSegments(safeTotal);
      setCompletedSegments(safeTotal);
    }
    cleanupSubscription();
    abortControllerRef.current = null;
    progressCompleteRef.current = true;
    setStatus('ready');
    setProgress(100);
  }, [cleanupSubscription]);

  const stopTracking = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    cleanupSubscription();
    progressCompleteRef.current = true;
    if (statusRef.current === 'generating') {
      setStatus('idle');
    }
  }, [cleanupSubscription]);

  const commitAudioPlayerSpeed = useCallback(() => {
    if (localAudioPlayerSpeed !== audioPlayerSpeed) {
      setAudioPlayerSpeedAndRestart(localAudioPlayerSpeed);
    }
  }, [audioPlayerSpeed, localAudioPlayerSpeed, setAudioPlayerSpeedAndRestart]);

  useEffect(() => {
    const onPageHide = () => stopTracking();
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      stopTracking();
    };
  }, [stopTracking]);

  const attachArtifact = useCallback((artifactOpId: string, controller: AbortController, fallbackTotal?: number | null) => {
    cleanupSubscription();
    setStatus('generating');
    unsubscribeRef.current = subscribeTtsExportArtifactEvents({
      opId: artifactOpId,
      documentId,
    }, {
      onSnapshot: async (snapshot) => {
        if (snapshot.status === 'failed') {
          progressCompleteRef.current = true;
          cleanupSubscription();
          abortControllerRef.current = null;
          setStatus('idle');
          setErrorMessage('Audiobook artifact preparation failed.');
          return;
        }

        const total = snapshot.plannedSegments !== null
          ? Math.max(0, Math.floor(snapshot.plannedSegments))
          : Math.max(0, Math.floor(fallbackTotal ?? 0));
        if (total > 0) {
          const completed = Math.max(0, Math.min(total, Math.floor(snapshot.completedSegments ?? 0)));
          setPlannedSegments(total);
          setCompletedSegments(completed);
          setProgress(clampProgress(completed, total));
        }

        if (snapshot.status === 'succeeded') {
          cleanupSubscription();
          const refreshed = await startDocumentAudioExport({
            format: exportFormat,
            speed: localAudioPlayerSpeed,
          }, controller.signal);
          if (controller.signal.aborted) return;
          setDownloadUrl(refreshed.downloadUrl);
          markReady(refreshed.plannedCount || total);
        }
      },
      onError: () => {},
    });
  }, [
    cleanupSubscription,
    documentId,
    exportFormat,
    localAudioPlayerSpeed,
    markReady,
    startDocumentAudioExport,
  ]);

  const beginArtifactPreparation = useCallback(async (controller: AbortController, fallbackTotal?: number | null) => {
    const refreshed = await startDocumentAudioExport({
      format: exportFormat,
      speed: localAudioPlayerSpeed,
    }, controller.signal);
    if (controller.signal.aborted) return;
    setDownloadUrl(refreshed.downloadUrl);
    const total = refreshed.plannedCount || fallbackTotal || 0;
    if (refreshed.downloadUrl || refreshed.artifactStatus === 'succeeded') {
      markReady(total);
      return;
    }
    if (refreshed.artifactOperationId) {
      attachArtifact(refreshed.artifactOperationId, controller, total);
    }
  }, [
    attachArtifact,
    exportFormat,
    localAudioPlayerSpeed,
    markReady,
    startDocumentAudioExport,
  ]);

  const attachGeneration = useCallback((input: {
    generationOperationId: string;
    controller: AbortController;
    plannedCount: number;
  }) => {
    cleanupSubscription();
    setStatus('generating');
    unsubscribeRef.current = subscribeTtsExportGenerationEvents({
      opId: input.generationOperationId,
      documentId,
    }, {
      onSnapshot: (snapshot) => {
        const total = snapshot.plannedCount ?? input.plannedCount;
        if (snapshot.status === 'failed') {
          progressCompleteRef.current = true;
          cleanupSubscription();
          abortControllerRef.current = null;
          setStatus('idle');
          setErrorMessage('Audio export failed.');
          return;
        }

        const completed = snapshot.status === 'succeeded'
          ? total
          : snapshot.completedCount !== null
            ? snapshot.completedCount
            : snapshot.completedThroughOrdinal === null
              ? 0
              : Math.min(total, snapshot.completedThroughOrdinal + 1);
        applyProgressSnapshot(completed, total);
        if (snapshot.status === 'succeeded' || (total > 0 && completed >= total)) {
          progressCompleteRef.current = true;
          cleanupSubscription();
          setProgress(100);
          void beginArtifactPreparation(input.controller, total);
        }
      },
      onError: () => {
        // EventSource reconnects automatically. Progress comes from operation
        // snapshots, so a transient disconnect is not a user-facing failure.
      },
    });
  }, [
    applyProgressSnapshot,
    beginArtifactPreparation,
    cleanupSubscription,
    documentId,
  ]);

  const handleStartGeneration = useCallback(async () => {
    cleanupSubscription();
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    progressCompleteRef.current = false;
    setStatus('generating');
    setProgress(0);
    setCompletedSegments(0);
    setPlannedSegments(0);
    setDownloadUrl(null);
    setErrorMessage(null);

    try {
      const session = await startDocumentAudioExport({
        format: exportFormat,
        speed: localAudioPlayerSpeed,
      }, controller.signal);
      if (controller.signal.aborted) return;
      setDownloadUrl(session.downloadUrl);
      setPlannedSegments(session.plannedCount);
      if (session.completedCount !== null) {
        setCompletedSegments(Math.max(0, Math.min(session.plannedCount, session.completedCount)));
        setProgress(clampProgress(session.completedCount, session.plannedCount));
      }
      if (session.downloadUrl || session.artifactStatus === 'succeeded') {
        markReady(session.plannedCount);
        return;
      }
      if (session.generationStatus === 'succeeded' && session.artifactOperationId) {
        attachArtifact(session.artifactOperationId, controller, session.plannedCount);
        return;
      }
      if (session.artifactOperationId) {
        attachArtifact(session.artifactOperationId, controller, session.plannedCount);
        return;
      }
      if (session.generationOperationId) {
        attachGeneration({
          generationOperationId: session.generationOperationId,
          controller,
          plannedCount: session.plannedCount,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus('idle');
      setErrorMessage(error instanceof Error ? error.message : 'Audio export failed.');
    }
  }, [
    attachArtifact,
    attachGeneration,
    cleanupSubscription,
    exportFormat,
    localAudioPlayerSpeed,
    markReady,
    startDocumentAudioExport,
  ]);

  useEffect(() => {
    if (!isOpen || isLoading || !voice) return;
    if (statusRef.current === 'generating' || statusRef.current === 'downloading') return;

    const controller = new AbortController();
    const runId = ++hydrateRunIdRef.current;
    let attachedSubscription = false;

    void (async () => {
      try {
        const snapshot = await resolveDocumentAudioExport({
          format: exportFormat,
          speed: localAudioPlayerSpeed,
        }, controller.signal);
        if (controller.signal.aborted || runId !== hydrateRunIdRef.current) return;

        const total = Math.max(0, Math.floor(snapshot.plannedCount));
        const completed = snapshot.completedCount !== null
          ? Math.max(0, Math.min(total, Math.floor(snapshot.completedCount)))
          : 0;
        setDownloadUrl(snapshot.downloadUrl);
        setPlannedSegments(total);
        setCompletedSegments(completed);
        setProgress(clampProgress(completed, total));
        setErrorMessage(null);

        if (snapshot.downloadUrl || snapshot.artifactStatus === 'succeeded') {
          markReady(total);
          return;
        }

        if (
          snapshot.artifactOperationId
          && (snapshot.artifactStatus === 'queued' || snapshot.artifactStatus === 'running')
        ) {
          attachedSubscription = true;
          attachArtifact(snapshot.artifactOperationId, controller, total);
          return;
        }

        if (snapshot.generationStatus === 'succeeded') {
          attachedSubscription = true;
          await beginArtifactPreparation(controller, total);
          return;
        }

        if (
          snapshot.generationOperationId
          && (snapshot.generationStatus === 'queued' || snapshot.generationStatus === 'running')
        ) {
          attachedSubscription = true;
          attachGeneration({
            generationOperationId: snapshot.generationOperationId,
            controller,
            plannedCount: total,
          });
          return;
        }

        setStatus('idle');
      } catch (error) {
        if (controller.signal.aborted || runId !== hydrateRunIdRef.current) return;
        setStatus('idle');
        setErrorMessage(error instanceof Error ? error.message : 'Audio export lookup failed.');
      }
    })();

    return () => {
      if (!attachedSubscription) {
        controller.abort();
        hydrateRunIdRef.current += 1;
      }
    };
  }, [
    attachArtifact,
    attachGeneration,
    beginArtifactPreparation,
    exportFormat,
    isLoading,
    isOpen,
    localAudioPlayerSpeed,
    markReady,
    resolveDocumentAudioExport,
    voice,
  ]);

  const handleDownload = useCallback(() => {
    const urlToDownload = downloadUrl ? withDownloadOptions(downloadUrl, localAudioPlayerSpeed, exportFormat) : null;
    if (!urlToDownload) return;
    setStatus('downloading');
    try {
      const link = document.createElement('a');
      link.href = urlToDownload;
      link.download = `openreader-${documentType}-${documentId.slice(0, 12)}.${exportFormat}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setStatus('complete');
    } catch (error) {
      setStatus('ready');
      setErrorMessage(error instanceof Error ? error.message : 'Download failed.');
    }
  }, [documentId, documentType, downloadUrl, exportFormat, localAudioPlayerSpeed]);

  if (isLoading) {
    return null;
  }

  return (
    <>
      <ProgressPopup
        isOpen={isGenerating && !isOpen}
        progress={progress}
        onCancel={stopTracking}
        cancelText="Dismiss"
        operationType="audiobook"
        onClick={() => setIsOpen(true)}
        currentChapter={`Preparing ${exportFormatLabel}`}
        statusMessage={progressStatusMessage}
      />

      <ReaderSidebarShell
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabel="Export audiobook"
        title="Export Audiobook"
        subtitle="Render this document to a downloadable audio file."
        bodyClassName="flex-1 overflow-y-auto px-4 py-4 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--accent),transparent_92%),transparent_35%)]"
      >
        <div className="space-y-4">
          <Section title="Voice" subtitle="Narration used for this export." variant="flat">
            <div className="space-y-1.5">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-faint">Voice</span>
              <VoicesControlBase
                availableVoices={availableVoices}
                voice={voice}
                onChangeVoice={setVoiceAndRestart}
                providerType={providerType}
                ttsModel={ttsModel}
                dropdownDirection="down"
                variant="field"
              />
            </div>
            {languageWarnings.map((warning) => (
              <p key={warning} className="text-xs text-warning">
                {warning}
              </p>
            ))}
          </Section>

          <Section title="Format & Speed" subtitle="File type and playback pace." variant="flat">
            <div className="space-y-1.5">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-faint">File format</span>
              <SegmentedControl<ExportFormat>
                value={exportFormat}
                options={EXPORT_FORMAT_OPTIONS}
                onChange={setExportFormat}
                ariaLabel="Audiobook export format"
                className="grid-cols-2"
              />
            </div>

            {nativeSpeedSupported ? (
              <RangeField
                label="Native model speed"
                value={voiceSpeed}
                min={0.5}
                max={3}
                step={0.1}
                formatter={(value) => `${formatSpeed(value)}x`}
                onChange={(value) => setSpeedAndRestart(value)}
                disabled={isGenerating}
              />
            ) : (
              <p className="text-xs text-faint">Native model speed is not available for this model.</p>
            )}

            <RangeField
              label="Audiobook speed"
              value={localAudioPlayerSpeed}
              min={0.5}
              max={3}
              step={0.1}
              formatter={(value) => `${formatSpeed(value)}x`}
              onChange={setLocalAudioPlayerSpeed}
              onMouseUp={commitAudioPlayerSpeed}
              onKeyUp={commitAudioPlayerSpeed}
              onTouchEnd={commitAudioPlayerSpeed}
              disabled={isGenerating}
            />
          </Section>

          <Section
            title="Export"
            subtitle="Generate audio, then download."
            variant="flat"
            action={
              <Badge tone={canDownload ? 'accent' : isGenerating ? 'foreground' : 'muted'}>
                {canDownload ? 'Ready' : isGenerating ? 'Generating' : 'Idle'}
              </Badge>
            }
          >
            <div className="flex items-center justify-between text-xs text-faint">
              <span>Segments</span>
              <span className="font-semibold text-foreground tabular-nums">
                {plannedSegments > 0 ? `${completedSegments}/${plannedSegments}` : '—'}
              </span>
            </div>

            {isGenerating && (
              <ProgressCard
                progress={progress}
                onCancel={stopTracking}
                operationType="audiobook"
                currentChapter={`Preparing ${exportFormatLabel}`}
                statusMessage={progressStatusMessage}
                cancelText="Dismiss"
              />
            )}

            <div className="flex items-center gap-2 pt-1">
              <Button
                onClick={handleStartGeneration}
                disabled={isGenerating || status === 'downloading' || !voice}
                variant="primary"
                size="md"
                className="flex-1"
              >
                {canDownload ? 'Regenerate' : 'Generate'}
              </Button>
              <Button
                onClick={handleDownload}
                disabled={!canDownload}
                variant="secondary"
                size="md"
                className="flex-1 gap-2"
              >
                <DownloadIcon className="h-4 w-4" />
                <span>{status === 'downloading' ? 'Downloading...' : 'Download'}</span>
              </Button>
            </div>
          </Section>
        </div>
      </ReaderSidebarShell>

      <ConfirmDialog
        isOpen={errorMessage !== null}
        onClose={() => setErrorMessage(null)}
        onConfirm={() => setErrorMessage(null)}
        title="Operation Failed"
        message={errorMessage || ''}
        confirmText="Close"
        cancelText=""
        isDangerous={false}
      />
    </>
  );
}
