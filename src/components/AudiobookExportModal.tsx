'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProgressPopup } from '@/components/ProgressPopup';
import { ProgressCard } from '@/components/ProgressCard';
import { DownloadIcon, CheckCircleIcon, ClockIcon } from '@/components/icons/Icons';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { VoicesControlBase } from '@/components/player/VoicesControlBase';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { getTtsLanguageCompatibilityWarnings } from '@openreader/tts/language';
import { Button, Card, RangeInput } from '@/components/ui';
import { getTtsPlaybackSeekLayout, subscribeTtsPlaybackEvents } from '@/lib/client/api/tts';

interface AudiobookExportModalProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  documentType: 'epub' | 'pdf' | 'html';
  documentId: string;
}

type ExportStatus = 'idle' | 'generating' | 'ready' | 'downloading' | 'complete';

function formatSpeed(speed: number): string {
  return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
}

function clampProgress(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
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
  } = useTTS();
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [completedSegments, setCompletedSegments] = useState(0);
  const [plannedSegments, setPlannedSegments] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const progressRequestRef = useRef<Promise<void> | null>(null);
  const progressSessionRef = useRef<{ seekLayoutUrl: string; plannedCount: number } | null>(null);
  const statusRef = useRef<ExportStatus>('idle');

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

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
  const canDownload = status === 'ready' || status === 'complete';
  const progressStatusMessage = plannedSegments > 0
    ? `${completedSegments}/${plannedSegments} segments ready`
    : 'Preparing segments';

  const cleanupSubscription = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  const cleanupProgressTimer = useCallback(() => {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
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
      cleanupSubscription();
      cleanupProgressTimer();
      abortControllerRef.current = null;
      setStatus('ready');
      setProgress(100);
    }
  }, [cleanupProgressTimer, cleanupSubscription]);

  const refreshProgressFromLayout = useCallback(async () => {
    const progressSession = progressSessionRef.current;
    if (!progressSession?.seekLayoutUrl) return;
    if (progressRequestRef.current) {
      await progressRequestRef.current;
      return;
    }
    const request = (async () => {
      const layout = await getTtsPlaybackSeekLayout(progressSession.seekLayoutUrl);
      const total = layout.segments.length || progressSession.plannedCount;
      const completed = layout.segments.filter((segment) => segment.generated || segment.audioState === 'ready').length;
      applyProgressSnapshot(completed, total);
    })().finally(() => {
      progressRequestRef.current = null;
    });
    progressRequestRef.current = request;
    await request;
  }, [applyProgressSnapshot]);

  const stopTracking = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    cleanupSubscription();
    cleanupProgressTimer();
    progressSessionRef.current = null;
    if (statusRef.current === 'generating') {
      setStatus('idle');
    }
  }, [cleanupProgressTimer, cleanupSubscription]);

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

  const handleStartGeneration = useCallback(async () => {
    cleanupSubscription();
    cleanupProgressTimer();
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    progressSessionRef.current = null;
    setStatus('generating');
    setProgress(0);
    setCompletedSegments(0);
    setPlannedSegments(0);
    setAudioUrl(null);
    setDownloadUrl(null);
    setErrorMessage(null);

    try {
      const session = await startDocumentAudioExport(controller.signal);
      if (controller.signal.aborted) return;
      setAudioUrl(session.audioUrl);
      setDownloadUrl(session.downloadUrl);
      setPlannedSegments(session.plannedCount);
      progressSessionRef.current = {
        seekLayoutUrl: session.seekLayoutUrl,
        plannedCount: session.plannedCount,
      };
      if (session.seekLayoutUrl) {
        void refreshProgressFromLayout().catch(() => undefined);
        progressTimerRef.current = window.setInterval(() => {
          void refreshProgressFromLayout().catch(() => undefined);
        }, 1500);
      }
      unsubscribeRef.current = subscribeTtsPlaybackEvents(session.sessionId, {
        onSnapshot: (snapshot) => {
          const total = snapshot.plannedCount ?? session.plannedCount;
          if (snapshot.status === 'failed') {
            cleanupSubscription();
            cleanupProgressTimer();
            abortControllerRef.current = null;
            setStatus('idle');
            setErrorMessage('Audio export failed.');
            return;
          }

          if (progressSessionRef.current?.seekLayoutUrl) {
            setPlannedSegments((current) => current > 0 ? current : total);
            void refreshProgressFromLayout().catch(() => undefined);
            return;
          }

          const completed = snapshot.status === 'succeeded'
            ? total
            : snapshot.completedThroughOrdinal === null
              ? 0
              : Math.min(total, snapshot.completedThroughOrdinal + 1);
          applyProgressSnapshot(completed, total);
          if (snapshot.status === 'succeeded' || (total > 0 && completed >= total)) {
            cleanupSubscription();
            cleanupProgressTimer();
            abortControllerRef.current = null;
            setStatus('ready');
            setProgress(100);
          }
        },
        onError: () => {
          if (!controller.signal.aborted) {
            setErrorMessage('Audio export progress disconnected.');
          }
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus('idle');
      setErrorMessage(error instanceof Error ? error.message : 'Audio export failed.');
    }
  }, [
    applyProgressSnapshot,
    cleanupProgressTimer,
    cleanupSubscription,
    refreshProgressFromLayout,
    startDocumentAudioExport,
  ]);

  const handleDownload = useCallback(() => {
    const urlToDownload = downloadUrl || audioUrl;
    if (!urlToDownload) return;
    setStatus('downloading');
    try {
      const link = document.createElement('a');
      link.href = urlToDownload;
      link.download = `openreader-${documentType}-${documentId.slice(0, 12)}.mp3`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setStatus('complete');
    } catch (error) {
      setStatus('ready');
      setErrorMessage(error instanceof Error ? error.message : 'Download failed.');
    }
  }, [audioUrl, documentId, documentType, downloadUrl]);

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
        currentChapter="Preparing MP3"
        statusMessage={progressStatusMessage}
      />

      <ReaderSidebarShell
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabel="Export audiobook"
        title="Export Audiobook"
        subtitle="MP3"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-background">
            <div className="flex items-center justify-between border-b border-line-soft bg-surface px-4 py-3">
              <h4 className="text-sm font-medium text-foreground tracking-tight">Export settings</h4>
              <span className="text-[11px] font-medium uppercase tracking-wider text-soft">MP3</span>
            </div>

            <div className="space-y-4 p-4">
              <div className="space-y-1.5">
                <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Voice</label>
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

              <Card className="p-3 space-y-3">
                {!nativeSpeedSupported && (
                  <div className="rounded-md border border-line bg-background px-2 py-1.5 text-[11px] text-soft">
                    Native model speed is not available for this model.
                  </div>
                )}

                {nativeSpeedSupported && (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Native model speed</label>
                        <span className="text-xs font-medium text-accent tabular-nums">{formatSpeed(voiceSpeed)}x</span>
                      </div>
                      <RangeInput
                        min="0.5"
                        max="3"
                        step="0.1"
                        value={voiceSpeed}
                        onChange={(event) => setSpeedAndRestart(parseFloat(event.target.value))}
                        disabled={isGenerating}
                      />
                    </div>
                  </>
                )}

                <div className={nativeSpeedSupported ? 'border-t border-line-soft' : ''} />

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Audio player speed</label>
                    <span className="text-xs font-medium text-accent tabular-nums">{formatSpeed(audioPlayerSpeed)}x</span>
                  </div>
                  <RangeInput
                    min="0.5"
                    max="3"
                    step="0.1"
                    value={audioPlayerSpeed}
                    onChange={(event) => setAudioPlayerSpeedAndRestart(parseFloat(event.target.value))}
                    disabled={isGenerating}
                  />
                </div>

              </Card>

              <div className="grid grid-cols-2 gap-3">
                <Card className="p-3">
                  <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Segments</div>
                  <div className="text-sm font-medium text-foreground tabular-nums">
                    {plannedSegments > 0 ? `${completedSegments}/${plannedSegments}` : '--'}
                  </div>
                </Card>
                <Card className="p-3">
                  <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Status</div>
                  <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {canDownload ? (
                      <CheckCircleIcon className="h-4 w-4 text-accent" />
                    ) : isGenerating ? (
                      <ClockIcon className="h-4 w-4 text-soft animate-spin" />
                    ) : (
                      <ClockIcon className="h-4 w-4 text-soft" />
                    )}
                    <span>{canDownload ? 'Ready' : isGenerating ? 'Generating' : 'Idle'}</span>
                  </div>
                </Card>
              </div>

              {isGenerating && (
                <ProgressCard
                  progress={progress}
                  onCancel={stopTracking}
                  operationType="audiobook"
                  currentChapter="Preparing MP3"
                  statusMessage={progressStatusMessage}
                  cancelText="Dismiss"
                />
              )}

              <div className="flex items-center gap-2">
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
            </div>
          </div>
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
