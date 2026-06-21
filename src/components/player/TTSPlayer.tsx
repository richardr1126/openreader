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

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function TTSPlayer({ currentPage, numPages, isPlaybackReady = true }: {
  currentPage?: number;
  numPages?: number | undefined;
  isPlaybackReady?: boolean;
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
    currentSentence,
    playbackSegments,
    playbackTimeSec,
    playbackDurationSec,
    playbackSeekLayout,
    seekPlaybackTo,
  } = useTTS();
  const [previewSec, setPreviewSec] = useState<number | null>(null);
  const shownSec = previewSec ?? playbackTimeSec;
  const previewSegment = useMemo(() => {
    if (!playbackSeekLayout) return null;
    const ms = shownSec * 1000;
    return playbackSeekLayout.segments.find((segment) => ms >= segment.startMs && ms < segment.endMs)
      ?? playbackSeekLayout.segments.at(-1)
      ?? null;
  }, [playbackSeekLayout, shownSec]);
  const previewText = previewSegment
    ? (playbackSegments.find((segment) => segment.ordinal === previewSegment.ordinal)?.text || currentSentence)
    : currentSentence;
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
    <div className="sticky bottom-0 z-30 w-full border-t border-line-soft bg-surface" data-app-ttsbar>
      {/* Single centered column; its width is driven by the controls row so the
          scrubber and status text line up to exactly that width. */}
      <div className="mx-auto flex w-fit flex-col items-stretch gap-1 px-2 md:px-3 pt-1 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        {/* Now-playing / seek-preview text */}
        <div className="w-0 min-w-full truncate text-center text-[11px] text-soft">
          {previewSegment
            ? `${previewSegment.estimated ? 'Estimated' : 'Ready'} · ${previewText || `Segment ${previewSegment.ordinal + 1}`}`
            : (currentSentence || 'Playback position')}
        </div>

        {/* Scrubber — full width of the column (== controls row width) */}
        <div className="flex w-full items-center gap-2 text-[11px] text-soft">
          <span className="w-10 tabular-nums text-right">{formatTime(shownSec)}</span>
          <div className="relative h-4 min-w-0 flex-1">
            <div
              aria-hidden
              className="pointer-events-none absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 rounded-full border border-line-soft"
              style={{ background: scrubberTrackBackground }}
            />
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
              className="absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed disabled:opacity-40 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-1 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-1 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
            />
          </div>
          <span className="w-10 tabular-nums">{formatTime(playbackDurationSec)}</span>
        </div>

        {/* Playback controls */}
        <div className="flex min-h-10 items-center justify-center gap-1">
          {/* Speed control */}
          <SpeedControl
            setSpeedAndRestart={setSpeedAndRestart}
            setAudioPlayerSpeedAndRestart={setAudioPlayerSpeedAndRestart}
          />

          {/* Page Navigation */}
          {currentPage && numPages && (
            <Navigator
              currentPage={currentPage}
              numPages={numPages}
              skipToLocation={skipToLocation}
            />
          )}

          {/* Playback Controls */}
          <IconButton
            onClick={skipBackward}
            aria-label="Skip backward"
            disabled={isProcessing || !isPlaybackReady}
            className="relative"
          >
            {isProcessing ? <LoadingSpinner /> : <SkipBackwardIcon className="w-5 h-5" />}
          </IconButton>

          <IconButton
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            disabled={!isPlaying && (!isPlaybackReady || isProcessing)}
            className="relative"
          >
            {!isPlaying && !isPlaybackReady
              ? <LoadingSpinner />
              : (isPlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5" />)}
          </IconButton>

          <IconButton
            onClick={skipForward}
            aria-label="Skip forward"
            disabled={isProcessing || !isPlaybackReady}
            className="relative"
          >
            {isProcessing ? <LoadingSpinner /> : <SkipForwardIcon className="w-5 h-5" />}
          </IconButton>

          {/* Voice control */}
          <VoicesControl availableVoices={availableVoices} setVoiceAndRestart={setVoiceAndRestart} />
        </div>
      </div>
    </div>
  );
}
