'use client';

import { useMemo, useState } from 'react';
import { useTTS } from '@/contexts/TTSContext';
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
import { formatPlaybackTime } from '@/lib/client/format-playback-time';

export default function TTSPlayer({ currentPage, numPages, isPlaybackReady = true, hasReadableContent = true }: {
  currentPage?: number;
  numPages?: number | undefined;
  isPlaybackReady?: boolean;
  hasReadableContent?: boolean;
}) {
  const {
    isPlaying,
    togglePlay,
    skipForward,
    skipBackward,
    isProcessing,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
    availableVoices,
    skipToLocation,
    playbackTimeSec,
    playbackDurationSec,
    playbackSeekLayout,
    seekPlaybackTo,
  } = useTTS();
  const [previewSec, setPreviewSec] = useState<number | null>(null);
  const shownSec = previewSec ?? playbackTimeSec;
  const canSeek = playbackDurationSec > 0 && Boolean(playbackSeekLayout);
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
    <div className="sticky bottom-0 z-30 w-full border-t border-line-soft bg-surface-solid backdrop-blur-sm" data-app-ttsbar>
      {/* Top Edge Scrubber bar */}
      <div className="group/scrubber absolute -top-[5px] left-0 right-0 h-2.5 z-40">
        {/* Track Base Rail (Empty Track) */}
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 bg-line-soft transition-[height] duration-fast group-hover/scrubber:h-[4px] group-active/scrubber:h-[4px] rounded-full" />
        
        {/* Generated Segments Track */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 transition-[height] duration-fast group-hover/scrubber:h-[4px] group-active/scrubber:h-[4px] rounded-full"
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
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-[3px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-fast
            [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--background)_70%,transparent),0_1px_6px_color-mix(in_srgb,var(--accent)_55%,transparent)]
            group-hover/scrubber:[&::-webkit-slider-thumb]:scale-y-125 group-active/scrubber:[&::-webkit-slider-thumb]:scale-y-150
            
            [&::-moz-range-track]:h-[2px] [&::-moz-range-track]:bg-transparent
            [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-[3px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-moz-range-thumb]:transition-transform [&::-moz-range-thumb]:duration-fast
            [&::-moz-range-thumb]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--background)_70%,transparent),0_1px_6px_color-mix(in_srgb,var(--accent)_55%,transparent)]
            group-hover/scrubber:[&::-moz-range-thumb]:scale-y-125 group-active/scrubber:[&::-moz-range-thumb]:scale-y-150"
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

      {/* Main Single Row Controls Layout */}
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-3 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        {/* Left side: Speed control & Voice control */}
        <div className="flex items-center gap-1 flex-1 min-w-0 justify-start">
          <SpeedControl
            setSpeedAndRestart={setSpeedAndRestart}
            setAudioPlayerSpeedAndRestart={setAudioPlayerSpeedAndRestart}
          />
          <VoicesControl availableVoices={availableVoices} setVoiceAndRestart={setVoiceAndRestart} />
        </div>

        {/* Center: Primary playback controls */}
        <div className="flex items-center gap-1.5">
          <IconButton
            onClick={skipBackward}
            aria-label="Skip backward"
            disabled={isProcessing || !isPlaybackReady || !hasReadableContent}
            className="relative"
          >
            {isProcessing ? <LoadingSpinner /> : <SkipBackwardIcon className="w-5 h-5" />}
          </IconButton>

          <IconButton
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            disabled={!isPlaying && (!isPlaybackReady || isProcessing || !hasReadableContent)}
            className="relative"
          >
            {!hasReadableContent
              ? <PlayIcon className="w-5 h-5" />
              : !isPlaying && !isPlaybackReady
              ? <LoadingSpinner />
              : (isPlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5" />)}
          </IconButton>

          <IconButton
            onClick={skipForward}
            aria-label="Skip forward"
            disabled={isProcessing || !isPlaybackReady || !hasReadableContent}
            className="relative"
          >
            {isProcessing ? <LoadingSpinner /> : <SkipForwardIcon className="w-5 h-5" />}
          </IconButton>
        </div>

        {/* Right side: Page Navigator & Timer display */}
        <div className="flex items-center gap-3 flex-1 justify-end">
          {currentPage && numPages && (
            <Navigator
              currentPage={currentPage}
              numPages={numPages}
              skipToLocation={skipToLocation}
            />
          )}
          <div className="text-[11px] text-soft font-mono tabular-nums select-none whitespace-nowrap">
            {hasReadableContent
              ? `${formatPlaybackTime(shownSec)} / ${formatPlaybackTime(playbackDurationSec)}`
              : 'No readable text'}
          </div>
        </div>
      </div>
    </div>
  );
}
