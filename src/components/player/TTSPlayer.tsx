'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTTS, useTTSPlaybackProgress } from '@/contexts/TTSContext';
import { measurePlaybackBuffer } from '@openreader/tts/playback-buffer';
import {
  PlayIcon,
  PauseIcon,
  SkipForwardIcon,
  SkipBackwardIcon,
} from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';
import { VoicesControl } from '@/components/player/VoicesControl';
import { SpeedControl } from '@/components/player/SpeedControl';
import { Navigator } from '@/components/player/Navigator';
import { IconButton } from '@/components/ui';
import { usePlanChangeConfirm } from '@/components/PlanChangeConfirm';
import { formatPlaybackTime } from '@/lib/client/format-playback-time';
import { resolvePlaybackControlPresentation } from '@/lib/client/tts/playback-control';

export default function TTSPlayer({ currentPage, numPages, isPlaybackReady: rendererPlaybackReady = true, hasReadableContent = true }: {
  currentPage?: number;
  numPages?: number | undefined;
  isPlaybackReady?: boolean;
  hasReadableContent?: boolean;
}) {
  const {
    isPlaying,
    playbackPhase,
    audioSpeed,
    togglePlay,
    skipForward,
    skipBackward,
    isProcessing,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
    availableVoices,
    skipToLocation,
    seekPlaybackTo,
    playbackPlanReady,
  } = useTTS();
  // A re-plan (voice, speed, language) keeps the reader mounted; playback waits
  // until the replacement plan is adopted.
  const playbackReady = rendererPlaybackReady && playbackPlanReady;
  const {
    playbackTimeSec,
    playbackDurationSec,
    playbackSeekLayout,
  } = useTTSPlaybackProgress();
  const { confirmPlanChange, planChangeDialog } = usePlanChangeConfirm();
  const confirmVoiceChange = useCallback((voice: string) => {
    confirmPlanChange({ setting: 'the voice', apply: () => setVoiceAndRestart(voice) });
  }, [confirmPlanChange, setVoiceAndRestart]);
  const confirmNativeSpeedChange = useCallback((speed: number, onCancel: () => void) => {
    confirmPlanChange({ setting: 'native model speed', apply: () => setSpeedAndRestart(speed), onCancel });
  }, [confirmPlanChange, setSpeedAndRestart]);
  const [previewSec, setPreviewSec] = useState<number | null>(null);
  const shownSec = previewSec ?? playbackTimeSec;
  const canSeek = playbackDurationSec > 0 && Boolean(playbackSeekLayout);
  const playbackControl = resolvePlaybackControlPresentation(isPlaying, playbackPhase);
  const aheadBuffer = useMemo(() => {
    if (!playbackSeekLayout || playbackSeekLayout.segments.length === 0) return null;
    const segment = playbackSeekLayout.segments.find(
      (entry) => playbackTimeSec * 1000 >= entry.startMs && playbackTimeSec * 1000 < entry.endMs,
    );
    if (!segment) return null;
    return measurePlaybackBuffer({
      segments: playbackSeekLayout.segments,
      startOrdinal: segment.ordinal,
      offsetWithinStartSegmentMs: Math.max(0, playbackTimeSec * 1000 - segment.startMs),
      playbackRate: audioSpeed,
    });
  }, [audioSpeed, playbackSeekLayout, playbackTimeSec]);
  const scrubberTrackBackground = useMemo(() => {
    if (!playbackSeekLayout || playbackSeekLayout.durationMs <= 0 || playbackSeekLayout.segments.length === 0) {
      return 'color-mix(in srgb, var(--foreground) 14%, transparent)';
    }
    const durationMs = Math.max(1, playbackSeekLayout.durationMs);
    const ready = 'color-mix(in srgb, var(--accent) 52%, var(--foreground))';
    const estimated = 'color-mix(in srgb, var(--foreground) 14%, transparent)';
    const stops: string[] = [];
    for (const segment of playbackSeekLayout.segments) {
      const start = Math.max(0, Math.min(100, (segment.startMs / durationMs) * 100));
      const end = Math.max(start, Math.min(100, (segment.endMs / durationMs) * 100));
      const color = segment.generated ? ready : estimated;
      stops.push(`${color} ${start.toFixed(3)}%`, `${color} ${end.toFixed(3)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [playbackSeekLayout]);

  return (
    <div className="sticky bottom-0 z-30 w-full border-t border-line-soft bg-surface-solid shadow-[0_-10px_30px_color-mix(in_srgb,var(--background)_45%,transparent)] backdrop-blur-sm sm:shadow-none" data-app-ttsbar>
      {/* Top Edge Scrubber bar */}
      <div className="group/scrubber absolute -top-2.5 left-0 right-0 z-40 h-5 sm:-top-[5px] sm:h-2.5">
        {/* Track Base Rail (Empty Track) */}
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-line-soft transition-[height] duration-fast group-hover/scrubber:h-[4px] group-active/scrubber:h-[4px] sm:h-[2px]" />
        
        {/* Generated Segments Track */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full transition-[height] duration-fast group-hover/scrubber:h-[4px] group-active/scrubber:h-[4px] sm:h-[2px]"
          style={{ background: scrubberTrackBackground }}
        />
        {/* Hidden active range slider overlay */}
        <input
          aria-label="Playback position"
          type="range"
          min={0}
          max={Math.max(0, Math.round(playbackDurationSec))}
          step={0.25}
          value={Math.min(Math.max(0, shownSec), Math.max(0, playbackDurationSec))}
          disabled={!canSeek}
          onChange={(event) => setPreviewSec(Number(event.currentTarget.value))}
          onPointerUp={(event) => {
            const target = Number((event.currentTarget as HTMLInputElement).value);
            setPreviewSec(null);
            seekPlaybackTo(target);
          }}
          onKeyUp={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const target = Number((event.currentTarget as HTMLInputElement).value);
            setPreviewSec(null);
            seekPlaybackTo(target);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed disabled:opacity-40
            [&::-webkit-slider-runnable-track]:h-[2px] [&::-webkit-slider-runnable-track]:bg-transparent
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-1 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:-mt-[7px] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-fast
            [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--background)_70%,transparent),0_1px_6px_color-mix(in_srgb,var(--accent)_55%,transparent)]
            group-hover/scrubber:[&::-webkit-slider-thumb]:scale-y-125 group-active/scrubber:[&::-webkit-slider-thumb]:scale-y-150
            sm:[&::-webkit-slider-thumb]:h-3 sm:[&::-webkit-slider-thumb]:w-[3px] sm:[&::-webkit-slider-thumb]:-mt-[5px]
            
            [&::-moz-range-track]:h-[3px] [&::-moz-range-track]:bg-transparent sm:[&::-moz-range-track]:h-[2px]
            [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-1 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-moz-range-thumb]:transition-transform [&::-moz-range-thumb]:duration-fast
            [&::-moz-range-thumb]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--background)_70%,transparent),0_1px_6px_color-mix(in_srgb,var(--accent)_55%,transparent)]
            group-hover/scrubber:[&::-moz-range-thumb]:scale-y-125 group-active/scrubber:[&::-moz-range-thumb]:scale-y-150
            sm:[&::-moz-range-thumb]:h-3 sm:[&::-moz-range-thumb]:w-[3px]"
        />
        {/* Tooltip Popup */}
        {previewSec !== null && playbackDurationSec > 0 && (
          <div
            className="absolute bottom-full mb-2.5 -translate-x-1/2 rounded bg-surface-solid border border-line-soft px-2 py-0.5 text-[10px] font-semibold text-foreground shadow-elev-2 pointer-events-none whitespace-nowrap"
            style={{
              left: `${Math.min(95, Math.max(5, (shownSec / playbackDurationSec) * 100))}%`
            }}
          >
            {formatPlaybackTime(shownSec)}
          </div>
        )}
      </div>

      <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] grid-rows-[auto_auto] items-center gap-x-2 gap-y-1 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:flex sm:justify-between sm:gap-4 sm:py-1.5 sm:pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        {/* Left side: Speed control & Voice control */}
        <div className="contents sm:flex sm:min-w-0 sm:flex-1 sm:items-center sm:justify-start sm:gap-1">
          <div className="col-start-1 row-start-2 justify-self-start">
            <SpeedControl
              disabled={isProcessing}
              setSpeedAndRestart={confirmNativeSpeedChange}
              setAudioPlayerSpeedAndRestart={setAudioPlayerSpeedAndRestart}
            />
          </div>
          <div className="col-start-3 row-start-2 justify-self-end">
            <VoicesControl
              availableVoices={availableVoices}
              disabled={isProcessing}
              setVoiceAndRestart={confirmVoiceChange}
            />
          </div>
        </div>

        {/* Center: Primary playback controls */}
        <div className="col-start-2 row-start-2 flex items-center gap-2 sm:gap-1.5">
          <IconButton
            onClick={skipBackward}
            aria-label="Skip backward"
            disabled={isProcessing || !playbackReady || !hasReadableContent}
            className="relative h-9 w-9 rounded-full sm:h-8 sm:w-8 sm:rounded-md"
          >
            {isProcessing ? <LoadingSpinner /> : <SkipBackwardIcon className="w-5 h-5" />}
          </IconButton>

          {/* Loading is cancelable through this same control. Keep it focusable
              when cancellation flips intent back to Play, even if an older async
              render has not cleared its processing flag yet. */}
          <IconButton
            onClick={togglePlay}
            aria-label={playbackControl.ariaLabel}
            aria-busy={playbackControl.isPending}
            disabled={!isPlaying && (!playbackReady || !hasReadableContent)}
            className="relative h-11 w-11 rounded-full bg-transparent text-soft hover:bg-accent-wash hover:text-accent sm:h-8 sm:w-8 sm:rounded-md"
          >
            {!hasReadableContent
              ? <PlayIcon className="w-5 h-5" />
              : !isPlaying && !playbackReady
              ? <LoadingSpinner />
              : playbackControl.isPending
              ? <LoadingSpinner />
              : (isPlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5" />)}
          </IconButton>

          <IconButton
            onClick={skipForward}
            aria-label="Skip forward"
            disabled={isProcessing || !playbackReady || !hasReadableContent}
            className="relative h-9 w-9 rounded-full sm:h-8 sm:w-8 sm:rounded-md"
          >
            {isProcessing ? <LoadingSpinner /> : <SkipForwardIcon className="w-5 h-5" />}
          </IconButton>
        </div>

        {/* Right side: Page Navigator & Timer display */}
        <div className="contents sm:flex sm:flex-1 sm:items-center sm:justify-end sm:gap-3">
          {currentPage && numPages && (
            <div className="col-span-3 row-start-3 mt-0.5 justify-self-center sm:mt-0">
              <Navigator
                currentPage={currentPage}
                numPages={numPages}
                skipToLocation={skipToLocation}
              />
            </div>
          )}
          <div className="col-span-2 col-start-1 row-start-1 justify-self-start whitespace-nowrap font-mono text-[11px] tabular-nums text-soft select-none">
            {hasReadableContent
              ? playbackControl.statusText
                ?? `${formatPlaybackTime(shownSec)} / ${formatPlaybackTime(playbackDurationSec)}`
              : 'No readable text'}
          </div>
          {aheadBuffer && (isPlaying || playbackPhase === 'buffering') && (
            <div
              className="col-start-3 row-start-1 justify-self-end whitespace-nowrap rounded-full bg-accent-wash px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-accent"
              aria-live="polite"
              aria-label={`${Math.floor(aheadBuffer.wallMs / 1000)} seconds ready ahead`}
            >
              {playbackPhase === 'buffering'
                ? `Loading ahead · ${Math.floor(aheadBuffer.wallMs / 1000)}s ready`
                : `${Math.floor(aheadBuffer.wallMs / 1000)}s ahead`}
            </div>
          )}
        </div>
      </div>
      {planChangeDialog}
    </div>
  );
}
