'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ProgressPopup } from '@/components/ProgressPopup';
import { ProgressCard } from '@/components/ProgressCard';
import { CheckIcon, ClockIcon, DownloadIcon, RefreshIcon, XCircleIcon } from '@/components/icons/Icons';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { VoicesControlBase } from '@/components/player/VoicesControlBase';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { getTtsLanguageCompatibilityWarnings } from '@openreader/tts/language';
import { Badge, Button, IconButton, RangeField, Section, SegmentedControl } from '@/components/ui';
import { useAudiobookExport, type AudiobookChapterDownloadState } from '@/hooks/audio/useAudiobookExport';
import { useTimeEstimation } from '@/hooks/useTimeEstimation';
import {
  describeExportIssue,
  describeGenerationState,
  describeSkippedSegments,
} from '@/lib/client/audiobook-export-issues';
import type { TtsExportChapterProgress, TtsExportGenerationState } from '@/types/tts-export';

interface AudiobookExportModalProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  documentType: 'epub' | 'pdf' | 'html';
  documentId: string;
  /** Reader-provided chapter label (for example an EPUB TOC entry). */
  resolveChapterTitle?: (chapter: TtsExportChapterProgress) => string | null;
}

type ExportFormat = 'mp3' | 'm4b';

const EXPORT_FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4b', label: 'M4B' },
];

const RESUMABLE_STATES: ReadonlySet<TtsExportGenerationState> = new Set([
  'stopped',
  'usage_limited',
  'interrupted',
  'failed',
]);

function formatSpeed(speed: number): string {
  return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function chapterIsSettled(chapter: TtsExportChapterProgress): boolean {
  return chapter.completedSegments > 0
    && chapter.completedSegments + chapter.skippedSegments === chapter.plannedSegments;
}

function ChapterStatusIcon({ chapter, active }: { chapter: TtsExportChapterProgress; active: boolean }) {
  if (chapterIsSettled(chapter)) {
    return chapter.skippedSegments > 0
      ? <XCircleIcon className="h-4 w-4 shrink-0 text-warning" aria-label="Done with skipped segments" />
      : <CheckIcon className="h-4 w-4 shrink-0 text-accent" aria-label="Done" />;
  }
  if (active && (chapter.generatingSegments > 0 || chapter.completedSegments > 0)) {
    return <RefreshIcon className="h-4 w-4 shrink-0 animate-spin text-accent" aria-label="Generating" />;
  }
  return <ClockIcon className="h-4 w-4 shrink-0 text-faint" aria-label={chapter.completedSegments > 0 ? 'Partial' : 'Pending'} />;
}

function ChapterRow({
  chapter,
  title,
  active,
  download,
  onDownload,
}: {
  chapter: TtsExportChapterProgress;
  title: string;
  active: boolean;
  download: AudiobookChapterDownloadState | undefined;
  onDownload: () => void;
}) {
  const settled = chapterIsSettled(chapter);
  const detail = settled
    ? formatDuration(chapter.durationMs)
    : chapter.completedSegments > 0
      ? `${chapter.completedSegments + chapter.skippedSegments}/${chapter.plannedSegments}`
      : '—';
  const preparing = download?.status === 'preparing';
  return (
    <li className="flex items-center gap-2 px-2 py-1 text-xs" title={download?.status === 'error' ? download.message : undefined}>
      <ChapterStatusIcon chapter={chapter} active={active} />
      <span className="min-w-0 flex-1 truncate text-foreground" title={title}>{title}</span>
      {chapter.skippedSegments > 0 && (
        <span className="shrink-0 text-warning tabular-nums" title={`${chapter.skippedSegments} skipped`}>
          −{chapter.skippedSegments}
        </span>
      )}
      <span className="shrink-0 text-faint tabular-nums">
        {preparing && download.progress !== null ? `${download.progress}%` : detail}
      </span>
      <IconButton
        size="sm"
        tone="ghost"
        className="h-6 w-6 shrink-0"
        onClick={onDownload}
        disabled={!settled || preparing}
        aria-label={`Download ${title}`}
        title={download?.status === 'error' ? download.message : settled ? 'Download chapter' : 'Not generated yet'}
      >
        {preparing
          ? <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
          : <DownloadIcon className={`h-3.5 w-3.5 ${download?.status === 'error' ? 'text-warning' : ''}`} />}
      </IconButton>
    </li>
  );
}

export function AudiobookExportModal({
  isOpen,
  setIsOpen,
  documentType,
  documentId,
  resolveChapterTitle,
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
    resolveDocumentAudioExport,
  } = useTTS();
  const [exportFormat, setExportFormat] = useState<ExportFormat>('mp3');
  const [localAudioPlayerSpeed, setLocalAudioPlayerSpeed] = useState(audioPlayerSpeed);

  useEffect(() => {
    setLocalAudioPlayerSpeed(audioPlayerSpeed);
  }, [audioPlayerSpeed]);

  const exportState = useAudiobookExport({
    documentId,
    isOpen,
    settingsKey: !isLoading && voice ? `${providerRef}|${ttsModel}|${voice}|${voiceSpeed}` : null,
    format: exportFormat,
    speed: audioPlayerSpeed,
    resolve: resolveDocumentAudioExport,
  });
  const {
    snapshot,
    liveCounts,
    artifactProgress,
    pendingAction,
    requestError,
    clearRequestError,
    chapterDownloads,
    start,
    stop,
    retrySkipped,
    downloadChapter,
  } = exportState;

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

  const generationState = snapshot?.generation.state ?? 'idle';
  const artifactState = snapshot?.artifact.state ?? 'none';
  const isQueued = generationState === 'queued';
  // A queued run already owns the export: it can be stopped and its settings
  // are locked, it just has not started producing audio yet.
  const isGenerating = generationState === 'generating' || isQueued;
  const isBuilding = artifactState === 'building';
  const isActive = isGenerating || isBuilding;
  const canDownload = Boolean(snapshot?.downloadUrl);
  const progress = snapshot?.progress ?? null;
  const planned = liveCounts?.planned ?? progress?.plannedSegments ?? 0;
  const skipped = liveCounts?.skipped ?? progress?.skippedSegments ?? 0;
  const settledCount = Math.min(planned, (liveCounts?.completed ?? progress?.completedSegments ?? 0) + skipped);
  const generationPercent = planned > 0 ? Math.round((settledCount / planned) * 100) : 0;
  const displayPercent = isBuilding ? artifactProgress ?? 0 : generationPercent;
  const narratedMs = useMemo(
    () => (progress?.chapters ?? []).reduce((sum, chapter) => sum + chapter.durationMs, 0),
    [progress],
  );

  const { setProgress: setEstimationProgress, estimatedTimeRemaining } = useTimeEstimation();
  useEffect(() => {
    if (isGenerating) setEstimationProgress(generationPercent);
  }, [generationPercent, isGenerating, setEstimationProgress]);

  const chapters = progress?.chapters ?? [];
  const activeChapter = isGenerating
    ? chapters.find((chapter) => !chapterIsSettled(chapter)) ?? null
    : null;
  const titleFor = useCallback(
    (chapter: TtsExportChapterProgress) => resolveChapterTitle?.(chapter) || chapter.title,
    [resolveChapterTitle],
  );

  const statusMessage = isBuilding
    ? `Building ${exportFormat.toUpperCase()} file`
    : isQueued
      ? 'Queued behind another export'
      : planned > 0
      ? `${settledCount}/${planned} segments${skipped > 0 ? ` · ${skipped} skipped` : ''}`
      : 'Preparing segments';
  const generationNotice = describeGenerationState(generationState, snapshot?.generation.issue ?? null);
  const skippedNotice = describeSkippedSegments(snapshot);
  const artifactNotice = artifactState === 'failed'
    ? `Building the ${exportFormat.toUpperCase()} file failed.${describeExportIssue(snapshot?.artifact.issue ?? null) ? ` ${describeExportIssue(snapshot?.artifact.issue ?? null)}` : ''} Select Build file to try again.`
    : null;

  const commitAudioPlayerSpeed = useCallback(() => {
    if (localAudioPlayerSpeed !== audioPlayerSpeed) {
      setAudioPlayerSpeedAndRestart(localAudioPlayerSpeed);
    }
  }, [audioPlayerSpeed, localAudioPlayerSpeed, setAudioPlayerSpeedAndRestart]);

  const handleDownload = useCallback(() => {
    if (!snapshot?.downloadUrl) return;
    const link = document.createElement('a');
    link.href = snapshot.downloadUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [snapshot]);

  const primaryAction = (() => {
    if (isGenerating) return { label: pendingAction === 'stop' ? 'Stopping…' : 'Stop', onClick: stop, variant: 'secondary' as const };
    if (RESUMABLE_STATES.has(generationState)) return { label: 'Resume', onClick: start, variant: 'primary' as const };
    if (generationState === 'complete') {
      return artifactState === 'failed' || artifactState === 'none' || artifactState === 'stale'
        ? { label: 'Build file', onClick: start, variant: 'primary' as const }
        : null;
    }
    return { label: 'Generate', onClick: start, variant: 'primary' as const };
  })();
  const badge = canDownload
    ? { label: 'Ready', tone: 'accent' as const }
    : isGenerating
      ? { label: isQueued ? 'Queued' : 'Generating', tone: 'foreground' as const }
      : isBuilding
        ? { label: 'Building', tone: 'foreground' as const }
        : RESUMABLE_STATES.has(generationState)
          ? { label: generationState === 'failed' ? 'Failed' : 'Paused', tone: 'muted' as const }
          : { label: 'Idle', tone: 'muted' as const };

  if (isLoading) {
    return null;
  }

  return (
    <>
      <ProgressPopup
        isOpen={isActive && !isOpen}
        progress={displayPercent}
        estimatedTimeRemaining={isGenerating ? estimatedTimeRemaining || undefined : undefined}
        onCancel={isGenerating ? stop : undefined}
        cancelText="Stop"
        operationType="audiobook"
        onClick={() => setIsOpen(true)}
        currentChapter={activeChapter ? titleFor(activeChapter) : `Preparing ${exportFormat.toUpperCase()}`}
        statusMessage={statusMessage}
      />

      <ReaderSidebarShell
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabel="Export audiobook"
        title="Export Audiobook"
        subtitle="Generation keeps running in the background until you stop it."
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
                disabled={isGenerating}
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
              disabled={isBuilding}
            />
            {isGenerating && (
              <p className="text-xs text-faint">Stop generation to change the voice or native speed.</p>
            )}
          </Section>

          <Section
            title="Export"
            subtitle="Generate audio, then download the book or single chapters."
            variant="flat"
            action={<Badge tone={badge.tone}>{badge.label}</Badge>}
          >
            <div className="flex items-center justify-between text-xs text-faint">
              <span>Segments</span>
              <span className="font-semibold text-foreground tabular-nums">
                {planned > 0 ? `${settledCount}/${planned}` : '—'}
                {narratedMs > 0 && <span className="ml-2 font-normal text-faint">{formatDuration(narratedMs)} narrated</span>}
              </span>
            </div>

            {isActive && (
              <ProgressCard
                progress={displayPercent}
                estimatedTimeRemaining={isGenerating ? estimatedTimeRemaining || undefined : undefined}
                operationType="audiobook"
                currentChapter={activeChapter ? titleFor(activeChapter) : undefined}
                statusMessage={statusMessage}
              />
            )}

            {generationNotice && <p role="status" className="text-xs text-warning">{generationNotice}</p>}
            {skippedNotice && <p className="text-xs text-warning">{skippedNotice}</p>}
            {artifactNotice && <p role="status" className="text-xs text-warning">{artifactNotice}</p>}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {primaryAction && (
                <Button
                  onClick={primaryAction.onClick}
                  disabled={!voice || pendingAction !== null || isBuilding}
                  variant={primaryAction.variant}
                  size="md"
                  className="flex-1"
                >
                  {primaryAction.label}
                </Button>
              )}
              <Button
                onClick={handleDownload}
                disabled={!canDownload}
                variant="secondary"
                size="md"
                className="flex-1 gap-2"
              >
                <DownloadIcon className="h-4 w-4" />
                <span>Download</span>
              </Button>
            </div>
            {skipped > 0 && !isActive && (
              <Button
                onClick={retrySkipped}
                disabled={pendingAction !== null}
                variant="ghost"
                size="sm"
                className="w-full gap-2"
              >
                <RefreshIcon className="h-4 w-4" />
                <span>Retry {skipped} skipped {skipped === 1 ? 'segment' : 'segments'}</span>
              </Button>
            )}
          </Section>

          {chapters.length > 0 && (
            <Section
              title={documentType === 'pdf' ? 'Pages' : 'Chapters'}
              subtitle={`${chapters.filter(chapterIsSettled).length}/${chapters.length} ready · download any finished one.`}
              variant="flat"
            >
              <ul
                aria-label="Audiobook chapters"
                className="max-h-72 divide-y divide-line-soft overflow-y-auto rounded-md border border-line-soft bg-surface-sunken"
              >
                {chapters.map((chapter) => (
                  <ChapterRow
                    key={chapter.index}
                    chapter={chapter}
                    title={titleFor(chapter)}
                    active={chapter.index === activeChapter?.index}
                    download={chapterDownloads[chapter.index]}
                    onDownload={() => void downloadChapter(chapter.index)}
                  />
                ))}
              </ul>
            </Section>
          )}
        </div>
      </ReaderSidebarShell>

      <ConfirmDialog
        isOpen={requestError !== null}
        onClose={clearRequestError}
        onConfirm={clearRequestError}
        title="Audiobook export"
        message={requestError || ''}
        confirmText="Close"
        cancelText=""
        isDangerous={false}
      />
    </>
  );
}
